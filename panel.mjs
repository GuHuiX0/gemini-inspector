// gemini-inspector :: live panel
//
// A SEPARATE process that tails the capture directory written by wiretap.mjs
// and serves an auto-refreshing dashboard. It never runs inside the CLI, so it
// cannot keep the CLI alive or slow it down.
//
//   node panel.mjs [--dir <capture dir>] [--port 5099] [--no-open]
//
// Endpoints:
//   /                        dashboard
//   /api/stats               aggregated metrics + time series
//   /api/index               every indexed exchange
//   /api/record/<dir>        full record for one exchange
//   /api/body/<dir>/request  archived request body
//   /api/body/<dir>/response archived response body

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';

// ------------------------------------------------------------------- config

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIR = path.resolve(
  arg('--dir', process.env.GEMINI_WIRETAP_DIR || path.join(process.cwd(), '.gemini-wiretap')),
);
const PORT = Number(arg('--port', process.env.GEMINI_INSPECT_PORT || 5099));
const OPEN = !process.argv.includes('--no-open');

// Price per 1M tokens (USD). Estimates only — verify against current pricing,
// and edit this table if a model is unpriced (the panel marks those as such).
const PRICING = [
  { match: /gemini-3.*pro/i, in: 2.0, out: 12.0 },
  { match: /gemini-3.*flash/i, in: 0.3, out: 2.5 },
  { match: /gemini-2\.5-pro/i, in: 1.25, out: 10.0 },
  { match: /gemini-2\.5-flash-lite/i, in: 0.1, out: 0.4 },
  { match: /gemini-2\.5-flash/i, in: 0.3, out: 2.5 },
  { match: /gemini-2\.0-flash/i, in: 0.1, out: 0.4 },
  { match: /gemini-1\.5-pro/i, in: 1.25, out: 5.0 },
  { match: /gemini-1\.5-flash/i, in: 0.075, out: 0.3 },
];

function priceFor(model) {
  if (!model) return null;
  const hit = PRICING.find((p) => p.match.test(model));
  return hit ? { in: hit.in, out: hit.out } : null;
}

function costOf(model, inTok, outTok) {
  const p = priceFor(model);
  if (!p) return null;
  return ((inTok || 0) / 1e6) * p.in + ((outTok || 0) / 1e6) * p.out;
}

// -------------------------------------------------------------------- store

const entries = [];
const byDir = new Set();
let lastSize = -1;
let rev = 0;

function loadIndex() {
  const file = path.join(DIR, 'index.jsonl');
  if (!fs.existsSync(file)) return { added: 0 };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { added: 0 };
  }
  if (stat.size === lastSize) return { added: 0 };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { added: 0 };
  }
  lastSize = stat.size;
  let added = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec.dir || byDir.has(rec.dir)) continue;
    byDir.add(rec.dir);
    entries.push(rec);
    added += 1;
  }
  if (added) rev += 1;
  return { added };
}

function stats() {
  const BUCKET = 10_000;
  const buckets = new Map();
  let inTok = 0;
  let outTok = 0;
  let cost = 0;
  let costKnown = 0;
  let errors = 0;
  let reqBytes = 0;
  let respBytes = 0;
  const lat = [];
  const models = new Map();
  const sessions = new Map();
  const heaviest = [];

  for (const e of entries) {
    const t = Number(e.t ? Date.parse(e.t) : Date.now()) || Date.now();
    const key = Math.floor(t / BUCKET) * BUCKET;
    const b = buckets.get(key) ?? { t: key, n: 0, err: 0, latSum: 0, latMax: 0, inTok: 0, outTok: 0 };
    b.n += 1;
    if (e.status >= 400 || e.status == null) b.err += 1;
    if (typeof e.durationMs === 'number' && e.durationMs >= 0) {
      b.latSum += e.durationMs;
      b.latMax = Math.max(b.latMax, e.durationMs);
      lat.push(e.durationMs);
    }
    b.inTok += e.inputTokens || 0;
    b.outTok += e.outputTokens || 0;
    buckets.set(key, b);

    if (e.status >= 400 || e.status == null) errors += 1;
    inTok += e.inputTokens || 0;
    outTok += e.outputTokens || 0;
    reqBytes += e.reqBytes || 0;
    respBytes += e.respBytes || 0;
    const c = costOf(e.model, e.inputTokens, e.outputTokens);
    if (c != null) {
      cost += c;
      costKnown += 1;
    }
    if (typeof e.reqBytes === 'number') {
      heaviest.push({ dir: e.dir, model: e.model, url: e.url, reqBytes: e.reqBytes, t: e.t, status: e.status });
    }
    const mk = e.model || '(unknown)';
    const m = models.get(mk) ?? { model: mk, n: 0, inTok: 0, outTok: 0, cost: 0, errors: 0, priced: true };
    m.n += 1;
    m.inTok += e.inputTokens || 0;
    m.outTok += e.outputTokens || 0;
    if (c == null) m.priced = false;
    m.cost += c || 0;
    if (e.status >= 400 || e.status == null) m.errors += 1;
    models.set(mk, m);

    // Group by the CLI's own session id when present; fall back to process id so
    // concurrent sessions sharing one capture dir stay distinguishable.
    const sk = e.sessionId ? `session ${e.sessionId}` : e.pid ? `pid ${e.pid}` : '(unlabelled)';
    const s = sessions.get(sk) ?? { key: sk, sessionId: e.sessionId ?? null, pid: e.pid ?? null, n: 0, inTok: 0, outTok: 0, cost: 0, errors: 0, first: t, last: t };
    s.n += 1;
    s.inTok += e.inputTokens || 0;
    s.outTok += e.outputTokens || 0;
    s.cost += c || 0;
    if (e.status >= 400 || e.status == null) s.errors += 1;
    s.first = Math.min(s.first, t);
    s.last = Math.max(s.last, t);
    sessions.set(sk, s);
  }

  lat.sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : null);

  return {
    dir: DIR,
    rev,
    total: entries.length,
    errors,
    errorRate: entries.length ? errors / entries.length : 0,
    latAvg: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    latP50: pct(50),
    latP95: pct(95),
    latMax: lat.length ? lat[lat.length - 1] : null,
    inTok,
    outTok,
    totalTokens: inTok + outTok,
    cost,
    costKnown,
    costComplete: costKnown === entries.length,
    reqBytes,
    respBytes,
    series: [...buckets.values()]
      .sort((a, b) => a.t - b.t)
      .slice(-120)
      .map((b) => ({
        t: b.t,
        n: b.n,
        err: b.err,
        latAvg: b.n ? Math.round(b.latSum / b.n) : 0,
        latMax: b.latMax,
        inTok: b.inTok,
        outTok: b.outTok,
      })),
    models: [...models.values()].sort((a, b) => b.n - a.n),
    sessions: [...sessions.values()].sort((a, b) => b.last - a.last),
    heaviest: heaviest.sort((a, b) => b.reqBytes - a.reqBytes).slice(0, 10),
  };
}

let cached = null;
let cachedRev = -1;
let cachedTotal = -1;
function statsCached() {
  if (cached && cachedRev === rev && cachedTotal === entries.length) return cached;
  cached = stats();
  cachedRev = rev;
  cachedTotal = entries.length;
  return cached;
}

// -------------------------------------------------------------------- http

function json(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function safeBase(dir) {
  return String(dir).replace(/[^0-9A-Za-z_-]/g, '_');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  loadIndex();

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(DASHBOARD);
    return;
  }
  if (url.pathname === '/api/stats') return json(res, 200, statsCached());
  if (url.pathname === '/api/index') return json(res, 200, { rev, dir: DIR, entries });

  if (url.pathname.startsWith('/api/record/')) {
    const file = path.join(DIR, `${safeBase(decodeURIComponent(url.pathname.slice('/api/record/'.length)))}.json`);
    if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
    try {
      return json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return json(res, 500, { error: 'unreadable' });
    }
  }

  const bodyMatch = url.pathname.match(/^\/api\/body\/([^/]+)\/(request|response)$/);
  if (bodyMatch) {
    const file = path.join(DIR, 'archive', `${safeBase(decodeURIComponent(bodyMatch[1]))}.${bodyMatch[2]}.bin`);
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('');
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// Poll instead of fs.watch: portable and immune to editor/platform quirks.
setInterval(() => {
  const { added } = loadIndex();
  if (added) {
    const s = statsCached();
    process.stdout.write(`[panel] +${added} exchange(s), total=${s.total} tokens=${s.totalTokens} cost=$${s.cost.toFixed(4)}\n`);
  }
}, 500).unref();

server.listen(PORT, '127.0.0.1', () => {
  loadIndex();
  const s = statsCached();
  const addr = `http://127.0.0.1:${PORT}`;
  process.stdout.write(`[panel] capture dir: ${DIR}\n`);
  process.stdout.write(`[panel] ${s.total} exchange(s) loaded; dashboard: ${addr}\n`);
  if (OPEN) {
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [addr], () => {});
  }
});

// ----------------------------------------------------------------- markup

const DASHBOARD = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>gemini-inspector panel</title>
<style>
 :root{--bg:#0b0e14;--panel:#141922;--panel2:#0f141c;--edge:#232a36;--fg:#dde3ee;--dim:#8892a4;--acc:#7aa2f7;--ok:#9ece6a;--warn:#e0af68;--err:#f7768e;--pur:#bb9af7}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
 header{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--edge);background:var(--panel);position:sticky;top:0;z-index:5}
 header h1{font-size:14px;margin:0;font-weight:600}
 .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok)}
 .muted{color:var(--dim)}
 .spacer{flex:1}
 input,select{background:var(--panel2);border:1px solid var(--edge);color:var(--fg);border-radius:6px;padding:5px 9px;font:inherit}
 main{padding:14px 16px 40px;display:grid;gap:14px}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
 .card{background:var(--panel);border:1px solid var(--edge);border-radius:10px;padding:10px 12px}
 .card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
 .card .v{font-size:21px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums}
 .card .s{color:var(--dim);font-size:11px}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
 @media(max-width:1050px){.grid{grid-template-columns:1fr}}
 .box{background:var(--panel);border:1px solid var(--edge);border-radius:10px;overflow:hidden}
 .box h2{font-size:12px;margin:0;padding:9px 12px;border-bottom:1px solid var(--edge);color:var(--dim);text-transform:uppercase;letter-spacing:.05em;font-weight:600}
 .box .body{padding:10px 12px}
 table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
 th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--edge);white-space:nowrap}
 th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;cursor:pointer;user-select:none}
 tbody tr{cursor:pointer}
 tbody tr:hover{background:#1a2130}
 tbody tr.sel{background:#22304a}
 .u{max-width:520px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom}
 .pill{padding:1px 6px;border-radius:999px;font-size:11px;border:1px solid var(--edge)}
 .p2{color:var(--ok);border-color:#2c4a2c} .p4{color:var(--warn);border-color:#4a3f2c} .p5{color:var(--err);border-color:#4a2c33}
 .num{text-align:right}
 .drawer{position:fixed;inset:0 0 0 auto;width:min(900px,72vw);background:var(--panel);border-left:1px solid var(--edge);box-shadow:-20px 0 50px #0008;transform:translateX(102%);transition:transform .18s ease;display:flex;flex-direction:column;z-index:20}
 .drawer.on{transform:none}
 .tabs{display:flex;gap:2px;border-bottom:1px solid var(--edge);background:var(--panel2)}
 .tabs button{background:none;border:none;color:var(--dim);padding:9px 13px;cursor:pointer;font:inherit}
 .tabs button.on{color:var(--acc);box-shadow:inset 0 -2px 0 var(--acc)}
 .pane{flex:1;overflow:auto;padding:12px 14px;font:12px/1.55 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
 .k{color:var(--acc)} .s{color:var(--ok)} .n{color:var(--warn)}
 .ev{border-left:2px solid var(--edge);margin:5px 0;padding:2px 0 2px 9px}
 .ev summary{cursor:pointer;color:var(--dim)}
 .close{margin-left:auto;background:none;border:1px solid var(--edge);color:var(--dim);border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit}
 .empty{color:var(--dim);padding:26px;text-align:center}
</style></head><body>
<header>
  <span class="dot" id="dot"></span>
  <h1>gemini-inspector</h1>
  <span class="muted" id="dir"></span>
  <span class="spacer"></span>
  <input id="q" placeholder="filter url / model…" size="26">
  <select id="fs"><option value="">all sessions</option></select>
  <select id="fm"><option value="">all models</option></select>
  <span class="muted" id="stamp"></span>
</header>
<main>
  <div class="cards" id="cards"></div>
  <div class="grid">
    <div class="box"><h2>Requests / 10s</h2><div class="body"><div id="chartReq"></div></div></div>
    <div class="box"><h2>Tokens / 10s</h2><div class="body"><div id="chartTok"></div></div></div>
  </div>
  <div class="grid">
    <div class="box"><h2>Models</h2><div class="body" style="padding:0"><table id="models"></table></div></div>
    <div class="box"><h2>Heaviest request bodies (context growth)</h2><div class="body" style="padding:0"><table id="heavy"></table></div></div>
  </div>
  <div class="box"><h2>Sessions</h2><div class="body" style="padding:0"><table id="sessions"></table></div></div>
  <div class="box"><h2>Exchanges</h2><div class="body" style="padding:0"><table id="list"></table></div></div>
</main>
<div class="drawer" id="drawer">
  <header><b id="dTitle"></b><span class="muted" id="dSub"></span><button class="close" id="dClose">close</button></header>
  <div class="tabs" id="dTabs"></div>
  <div class="pane" id="dPane"></div>
</div>
<script>
let STATS=null, ENTRIES=[], curDir=null, tab='summary', sortKey='t', sortDir=-1;
const records=new Map();
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const fmt=(n)=>n==null?'-':n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);
const ms=(n)=>n==null?'-':n>=1000?(n/1000).toFixed(2)+'s':n+'ms';
function hl(o){return esc(JSON.stringify(o,null,2)).replace(/"([^"]+)":/g,'<span class="k">"$1"</span>:').replace(/: "((?:[^"\\]|\\.)*)"/g,': <span class="s">"$1"</span>').replace(/: (true|false|null|-?[0-9.]+)/g,': <span class="n">$1</span>')}

function chart(el, series, keys, colors, height){
  const W=el.clientWidth||520, H=height||120, P={l:36,r:8,t:8,b:16};
  const n=series.length;
  if(!n){el.innerHTML='<div class="empty">waiting for traffic…</div>';return}
  const max=Math.max(1,...series.map(s=>Math.max(...keys.map(k=>s[k]||0))));
  const bw=Math.max(2,(W-P.l-P.r)/n-2);
  const y=(v)=>P.t+(H-P.t-P.b)*(1-v/max);
  let bars='';
  series.forEach((s,i)=>{
    const x=P.l+i*((W-P.l-P.r)/n);
    let stack=0;
    keys.forEach((k,ki)=>{
      const v=s[k]||0; if(!v) return;
      const h=(H-P.t-P.b)*(v/max);
      bars+='<rect x="'+x.toFixed(1)+'" y="'+y(stack+v).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(0.8,h).toFixed(1)+'" fill="'+colors[ki]+'" rx="1.5"/>';
      stack+=v;
    });
  });
  const grid=[0,.5,1].map(f=>'<line x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(max*f).toFixed(1)+'" y2="'+y(max*f).toFixed(1)+'" stroke="#232a36"/><text x="4" y="'+(y(max*f)+4).toFixed(1)+'" fill="#8892a4" font-size="10">'+fmt(Math.round(max*f))+'</text>').join('');
  el.innerHTML='<svg width="100%" height="'+H+'" viewBox="0 0 '+W+' '+H+'">'+grid+bars+'</svg>';
}

function renderCards(s){
  const cards=[
    ['exchanges', s.total, s.errors? s.errors+' error(s)':'no errors', s.errors?'var(--err)':'var(--ok)'],
    ['error rate', s.total?(100*s.errorRate).toFixed(1)+'%':'-', s.errorRate>0.05?'elevated':'healthy', s.errorRate>0.05?'var(--warn)':'var(--ok)'],
    ['latency p50', ms(s.latP50), 'avg '+ms(s.latAvg)],
    ['latency p95', ms(s.latP95), 'max '+ms(s.latMax)],
    ['input tokens', fmt(s.inTok), 'from usageMetadata'],
    ['output tokens', fmt(s.outTok), 'generated'],
    ['est. cost', '$'+(s.cost||0).toFixed(4), s.costComplete?'all models priced':'partial (unpriced models)', 'var(--pur)'],
    ['bytes', fmt(s.reqBytes)+' in', fmt(s.respBytes)+' out'],
  ];
  $('cards').innerHTML=cards.map(([k,v,sub,c])=>'<div class="card"><div class="k">'+k+'</div><div class="v" style="'+(c?'color:'+c:'')+'">'+v+'</div><div class="s">'+esc(sub)+'</div></div>').join('');
}

function renderModels(s){
  const rows=s.models.map(m=>'<tr><td>'+esc(m.model)+'</td><td class="num">'+m.n+'</td><td class="num">'+fmt(m.inTok)+'</td><td class="num">'+fmt(m.outTok)+'</td><td class="num">'+(m.priced?'$'+m.cost.toFixed(4):'n/a')+'</td><td class="num" style="color:'+(m.errors?'var(--err)':'var(--dim)')+'">'+m.errors+'</td></tr>').join('');
  $('models').innerHTML='<thead><tr><th>model</th><th class="num">reqs</th><th class="num">in</th><th class="num">out</th><th class="num">cost</th><th class="num">err</th></tr></thead><tbody>'+(rows||'<tr><td colspan="6" class="empty">no data</td></tr>')+'</tbody>';
  const sel=$('fm'), keep=sel.value;
  sel.innerHTML='<option value="">all models</option>'+s.models.map(m=>'<option>'+esc(m.model)+'</option>').join('');
  sel.value=keep;
}

function renderHeavy(s){
  const rows=s.heaviest.map(h=>'<tr data-d="'+esc(h.dir)+'"><td class="num">'+fmt(h.reqBytes)+'</td><td>'+esc(h.model||'-')+'</td><td><span class="u">'+esc((h.url||'').replace(/^https?:\/\//,''))+'</span></td></tr>').join('');
  $('heavy').innerHTML='<thead><tr><th class="num">req bytes</th><th>model</th><th>url</th></tr></thead><tbody>'+(rows||'<tr><td colspan="3" class="empty">no data</td></tr>')+'</tbody>';
  [...$('heavy').querySelectorAll('tbody tr[data-d]')].forEach(tr=>tr.onclick=()=>openRecord(tr.dataset.d));
}

function renderSessions(s){
  const rows=s.sessions.map(x=>{
    const span=x.last-x.first;
    return '<tr data-s="'+esc(x.key)+'"><td>'+esc(x.key)+'</td><td class="num">'+x.n+'</td>'+
      '<td class="num">'+fmt(x.inTok)+'</td><td class="num">'+fmt(x.outTok)+'</td><td class="num">$'+x.cost.toFixed(4)+'</td>'+
      '<td class="num" style="color:'+(x.errors?'var(--err)':'var(--dim)')+'">'+x.errors+'</td>'+
      '<td class="muted">'+new Date(x.first).toLocaleTimeString()+'</td>'+
      '<td class="muted">'+ms(span)+'</td></tr>';
  }).join('');
  $('sessions').innerHTML='<thead><tr><th>session</th><th class="num">reqs</th><th class="num">in</th><th class="num">out</th><th class="num">cost</th><th class="num">err</th><th>first</th><th>span</th></tr></thead><tbody>'+
    (rows||'<tr><td colspan="8" class="empty">no data</td></tr>')+'</tbody>';
  [...$('sessions').querySelectorAll('tbody tr[data-s]')].forEach(tr=>tr.onclick=()=>{
    const sel=$('fs'); sel.value = (sel.value===tr.dataset.s)?'':tr.dataset.s; renderList();
  });
  const sel=$('fs'), keep=sel.value;
  sel.innerHTML='<option value="">all sessions</option>'+s.sessions.map(x=>'<option>'+esc(x.key)+'</option>').join('');
  sel.value=keep;
}

function filtered(){
  const q=$('q').value.toLowerCase(), m=$('fm').value, ss=$('fs').value;
  const list=ENTRIES.filter(e=>{
    if (m && e.model!==m) return false;
    if (ss && sessKey(e)!==ss) return false;
    if (q && !((e.url||'')+(e.model||'')+(e.sessionId||'')).toLowerCase().includes(q)) return false;
    return true;
  });
  list.sort((a,b)=>{
    const av=a[sortKey], bv=b[sortKey];
    if(av==null&&bv==null) return 0; if(av==null) return 1; if(bv==null) return -1;
    return (av>bv?1:av<bv?-1:0)*sortDir;
  });
  return list;
}

function sessKey(e){ return e.sessionId ? 'session '+e.sessionId : e.pid ? 'pid '+e.pid : '(unlabelled)' }
function shortSess(e){ const k=sessKey(e); return k.length>18 ? k.slice(0,17)+'…' : k }

function renderList(){
  const list=filtered();
  const head=[['t','time'],['method','method'],['model','model'],['status','status'],['durationMs','latency'],['reqBytes','req B'],['inputTokens','in tok'],['outputTokens','out tok'],['sessionId','session'],['url','url']];
  $('list').innerHTML='<thead><tr>'+head.map(([k,l])=>'<th data-k="'+k+'">'+l+(sortKey===k?(sortDir>0?' ▲':' ▼'):'')+'</th>').join('')+'</tr></thead><tbody>'+
    (list.map(e=>{
      const t=e.t?new Date(e.t).toLocaleTimeString():'-';
      const cls=e.status==null?'p5':e.status<300?'p2':e.status<500?'p4':'p5';
      return '<tr data-d="'+esc(e.dir)+'" class="'+(curDir===e.dir?'sel':'')+'">'+
        '<td class="muted">'+esc(t)+'</td><td>'+esc(e.method)+'</td><td>'+esc(e.model||'-')+'</td>'+
        '<td><span class="pill '+cls+'">'+(e.status==null?'-':e.status)+'</span>'+(e.stream?' <span class="pill">SSE</span>':'')+'</td>'+
        '<td class="num">'+ms(e.durationMs)+'</td><td class="num">'+fmt(e.reqBytes)+'</td>'+
        '<td class="num">'+fmt(e.inputTokens)+'</td><td class="num">'+fmt(e.outputTokens)+'</td>'+
        '<td class="muted" title="'+esc(sessKey(e))+'">'+esc(shortSess(e))+'</td>'+
        '<td><span class="u">'+esc((e.url||'').replace(/^https?:\/\//,''))+'</span></td></tr>';
    }).join('')||'<tr><td colspan="10" class="empty">no exchanges yet — run gemini with the hook enabled</td></tr>')+'</tbody>';
  [...$('list').querySelectorAll('thead th[data-k]')].forEach(th=>th.onclick=()=>{const k=th.dataset.k; if(sortKey===k) sortDir*=-1; else {sortKey=k;sortDir=-1} renderList()});
  [...$('list').querySelectorAll('tbody tr[data-d]')].forEach(tr=>tr.onclick=()=>openRecord(tr.dataset.d));
}

function renderTabs(){
  const names=['summary','request','response','raw'];
  $('dTabs').innerHTML=names.map(n=>'<button class="'+(n===tab?'on':'')+'" data-n="'+n+'">'+n+'</button>').join('');
  [...$('dTabs').querySelectorAll('button')].forEach(b=>b.onclick=()=>{tab=b.dataset.n;renderTabs();renderDrawer()});
}

function sseEvents(text){
  const out=[];let ev=null,data=[];
  const flush=()=>{if(ev!==null||data.length){const raw=data.join('\n');let p=null;try{p=JSON.parse(raw)}catch{}out.push({event:ev,data:p==null?raw:p})}ev=null;data=[]};
  for(const line of String(text).split(/\r?\n/)){
    if(line===''){flush();continue}
    if(line.startsWith(':'))continue;
    if(line.startsWith('event:'))ev=line.slice(6).trim();
    else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
  }
  flush();return out;
}

async function bodyText(dir,which){
  try{
    const r=await fetch('/api/body/'+encodeURIComponent(dir)+'/'+which);
    if(!r.ok) return '';
    const t=await r.text();
    if(!t) return '';
    let p=null; try{p=JSON.parse(t)}catch{}
    return p?JSON.stringify(p,null,2):t;
  }catch{ return '' }
}

async function openRecord(dir){
  curDir=dir; renderList();
  $('drawer').classList.add('on');
  $('dTitle').textContent=dir;
  $('dSub').textContent='';
  $('dPane').innerHTML='<div class="empty">loading…</div>';
  renderTabs();
  if(!records.has(dir)){
    try{ records.set(dir, await (await fetch('/api/record/'+encodeURIComponent(dir))).json()); }
    catch{ $('dPane').innerHTML='<div class="empty">record not readable</div>'; return }
  }
  renderDrawer();
}

async function renderDrawer(){
  if(!curDir) return;
  const rec=records.get(curDir); if(!rec) return;
  const e=ENTRIES.find(x=>x.dir===curDir)||{};
  $('dSub').textContent=[e.model,ms(e.durationMs),e.status].filter(Boolean).join(' · ');
  if(tab==='summary'){
    $('dPane').innerHTML='<pre>'+hl({method:rec.method,url:rec.url,scope:rec.scope,
      request:rec.request&&{...rec.request,preview:undefined},
      response:rec.response&&{...rec.response,preview:undefined}})+'</pre>';
    return;
  }
  if(tab==='raw'){
    const [req,resp]=await Promise.all([bodyText(curDir,'request'),bodyText(curDir,'response')]);
    $('dPane').innerHTML='<pre>--- request ---\n'+esc(req||'(none)')+'\n\n--- response ---\n'+esc(resp||'(none)')+'</pre>';
    return;
  }
  const body=await bodyText(curDir,tab);
  if(tab==='request'){ $('dPane').innerHTML='<pre>'+esc(body||'(no request body)')+'</pre>'; return }
  if(rec.response&&rec.response.isStream){
    const evs=sseEvents(body);
    $('dPane').innerHTML=evs.map((ev,i)=>'<details class="ev"'+(i<3?' open':'')+'><summary>#'+i+(ev.event?' ['+esc(ev.event)+']':'')+'</summary><pre>'+hl(ev.data)+'</pre></details>').join('')||'<div class="empty">empty stream</div>';
    return;
  }
  let parsed=null; try{parsed=JSON.parse(body)}catch{}
  $('dPane').innerHTML='<pre>'+(parsed?hl(parsed):esc(body||'(no response body)'))+'</pre>';
}

async function tick(){
  try{
    const [s,idx]=await Promise.all([fetch('/api/stats').then(r=>r.json()),fetch('/api/index').then(r=>r.json())]);
    STATS=s; ENTRIES=idx.entries||[];
    $('dir').textContent=s.dir;
    $('stamp').textContent=new Date().toLocaleTimeString();
    $('dot').style.background='var(--ok)';
    renderCards(s); renderModels(s); renderSessions(s); renderHeavy(s); renderList();
    chart($('chartReq'),s.series,['n','err'],['#7aa2f7','#f7768e']);
    chart($('chartTok'),s.series,['inTok','outTok'],['#9ece6a','#bb9af7']);
  }catch(e){ $('dot').style.background='var(--err)' }
}
$('dClose').onclick=()=>{$('drawer').classList.remove('on');curDir=null;renderList()};
$('q').oninput=renderList; $('fm').onchange=renderList; $('fs').onchange=renderList;
window.addEventListener('resize',()=>{ if(STATS){chart($('chartReq'),STATS.series,['n','err'],['#7aa2f7','#f7768e']);chart($('chartTok'),STATS.series,['inTok','outTok'],['#9ece6a','#bb9af7'])} });
tick(); setInterval(tick,1000);
</script></body></html>`;
