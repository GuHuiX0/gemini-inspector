// gemini-inspector :: offline viewer
//
// Builds a self-contained HTML viewer plus a greppable text summary from a
// capture directory. Useful when you do not want to keep a server running, or
// when you want to hand a capture bundle to someone else.
//
//   node genview.mjs [--dir <capture dir>] [--open]

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dir = path.resolve(
  flag('--dir') || process.env.GEMINI_WIRETAP_DIR || path.join(process.cwd(), '.gemini-wiretap'),
);
const wantOpen = args.includes('--open');
const EMBED_LIMIT = Number(process.env.GEMINI_INSPECT_EMBED_LIMIT || 2_000_000);

const indexPath = path.join(dir, 'index.jsonl');
if (!fs.existsSync(indexPath)) {
  console.error(`no index.jsonl in ${dir}`);
  console.error('run gemini with the hook first, or point --dir at a capture directory');
  process.exit(1);
}

const indexEntries = fs
  .readFileSync(indexPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// First index row per capture dir wins; later rows are completion updates.
const seen = new Set();
const entries = [];
for (const entry of indexEntries) {
  if (!entry.dir || seen.has(entry.dir)) continue;
  seen.add(entry.dir);
  entries.push(entry);
}

function readRecord(entry) {
  const file = path.join(dir, `${entry.dir}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readBody(entry, which) {
  const file = path.join(dir, 'archive', `${entry.dir}.${which}.bin`);
  if (!fs.existsSync(file)) return { text: null, bytes: 0, truncated: false };
  const size = fs.statSync(file).size;
  const buf = fs.readFileSync(file);
  const slice = buf.length > EMBED_LIMIT ? buf.subarray(0, EMBED_LIMIT) : buf;
  return {
    text: slice.toString('utf8'),
    bytes: size,
    truncated: buf.length > EMBED_LIMIT,
    isBinary: slice.includes(0),
  };
}

function requestHeaderText(record) {
  if (!record?.request) return '';
  const headers = Object.entries(record.request.headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `${record.method} ${record.url}\n${headers}`;
}

const payload = [];
const summary = [];

for (const entry of entries) {
  const record = readRecord(entry);
  const req = readBody(entry, 'request');
  const resp = readBody(entry, 'response');

  payload.push({
    dir: entry.dir,
    method: entry.method,
    url: entry.url,
    scope: entry.scope,
    status: entry.status ?? record?.response?.status ?? null,
    durationMs: entry.durationMs ?? record?.durationMs ?? null,
    stream: !!entry.stream,
    ws: record?.kind === 'websocket',
    meta: record,
    requestText: [requestHeaderText(record), req.text ?? record?.request?.preview ?? '']
      .filter(Boolean)
      .join('\n\n'),
    responseText: resp.text,
    responseTruncated: resp.truncated,
  });

  summary.push(
    `\n${'='.repeat(100)}\n${entry.method} ${entry.url} -> ${entry.status ?? '-'}` +
      `${entry.stream ? ' (stream)' : ''} ${entry.durationMs ?? '?'}ms`,
  );
  if (record?.request) {
    summary.push(`  request body: ${record.request.bodyBytes} bytes (${record.request.bodyKind})`);
    for (const [k, v] of Object.entries(record.request.headers || {})) summary.push(`  > ${k}: ${v}`);
  }
  const s = record?.response?.sseSummary;
  if (s) {
    summary.push(`  SSE events=${s.eventCount} ${s.finishReasons.join(' ')} ${s.usage ?? ''}`);
    summary.push(`  text: ${JSON.stringify(s.textPreview)} (len=${s.textLength})`);
  }
  const usage = record?.response?.usage;
  if (usage) summary.push(`  usage: ${JSON.stringify(usage)}`);
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>gemini-inspector</title>
<style>
 :root{--bg:#0f1115;--panel:#161a22;--edge:#252b36;--fg:#dfe4ee;--dim:#8b93a5;--acc:#7aa2f7;--ok:#9ece6a;--warn:#e0af68;--err:#f7768e}
 *{box-sizing:border-box}
 body{margin:0;font:13px/1.5 ui-monospace,Consolas,monospace;background:var(--bg);color:var(--fg);display:flex;height:100vh}
 #side{width:430px;min-width:280px;border-right:1px solid var(--edge);overflow:auto;background:var(--panel)}
 #side h1{font-size:13px;margin:0;padding:12px;border-bottom:1px solid var(--edge);color:var(--acc)}
 .item{padding:8px 12px;border-bottom:1px solid var(--edge);cursor:pointer}
 .item:hover{background:#1d2330}
 .item.sel{background:#233047}
 .row{display:flex;gap:6px;align-items:center}
 .m{color:var(--dim)} .u{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .badge{padding:0 5px;border-radius:3px;font-size:11px;border:1px solid var(--edge)}
 .s2{color:var(--ok);border-color:var(--ok)} .s4{color:var(--warn);border-color:var(--warn)} .s5{color:var(--err);border-color:var(--err)}
 #main{flex:1;display:flex;flex-direction:column;min-width:0}
 #tabs{display:flex;border-bottom:1px solid var(--edge);background:var(--panel)}
 #tabs button{background:none;border:none;color:var(--dim);padding:10px 14px;cursor:pointer;font:inherit}
 #tabs button.on{color:var(--acc);border-bottom:2px solid var(--acc)}
 #pane{flex:1;overflow:auto;padding:14px;white-space:pre-wrap;word-break:break-word}
 pre{margin:0}
 .k{color:var(--acc)} .s{color:var(--ok)} .n{color:var(--warn)}
 .ev{border-left:2px solid var(--edge);margin:6px 0;padding:2px 0 2px 10px}
 .ev summary{cursor:pointer;color:var(--dim)}
 .hint{color:var(--dim);padding:14px}
</style></head><body>
<div id="side"><h1>gemini-inspector · ${entries.length} exchange(s)</h1><div id="list"></div></div>
<div id="main"><div id="tabs"></div><div id="pane"><div class="hint">Select an exchange on the left.</div></div></div>
<script id="data" type="application/json">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>
<script>
const DATA=JSON.parse(document.getElementById('data').textContent);
const list=document.getElementById('list'), pane=document.getElementById('pane'), tabs=document.getElementById('tabs');
let cur=0, tab='summary';
const esc=(s)=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function hl(o){return esc(JSON.stringify(o,null,2)).replace(/"([^"]+)":/g,'<span class="k">"$1"</span>:').replace(/: "((?:[^"\\\\]|\\\\.)*)"/g,': <span class="s">"$1"</span>').replace(/: (true|false|null|-?[0-9.]+)/g,': <span class="n">$1</span>')}
function statusClass(s){if(s==null)return '';if(s<300)return 's2';if(s<500)return 's4';return 's5'}
function renderList(){
  list.innerHTML=DATA.map((d,i)=>'<div class="item '+(i===cur?'sel':'')+'" data-i="'+i+'">'+
    '<div class="row"><span class="badge '+statusClass(d.status)+'">'+(d.status==null?'-':d.status)+'</span>'+
    '<span class="m">'+esc(d.method)+'</span>'+(d.stream?'<span class="badge">SSE</span>':'')+(d.ws?'<span class="badge">WS</span>':'')+
    '<span class="m" style="margin-left:auto">'+(d.durationMs==null?'?':d.durationMs+'ms')+'</span></div>'+
    '<div class="u">'+esc((d.url||'').replace(/^https?:\\/\\//,''))+'</div></div>').join('');
  [...list.querySelectorAll('.item')].forEach(el=>el.onclick=()=>{cur=+el.dataset.i;renderList();render()});
}
function renderTabs(){
  const names=['summary','request','response','raw'];
  tabs.innerHTML=names.map(n=>'<button class="'+(n===tab?'on':'')+'" data-n="'+n+'">'+n+'</button>').join('');
  [...tabs.querySelectorAll('button')].forEach(b=>b.onclick=()=>{tab=b.dataset.n;renderTabs();render()});
}
function sseEvents(text){
  const out=[];let ev=null,data=[];
  const flush=()=>{if(ev!==null||data.length){const raw=data.join('\\n');let p=null;try{p=JSON.parse(raw)}catch{}out.push({event:ev,data:p==null?raw:p})}ev=null;data=[]};
  for(const line of String(text).split(/\\r?\\n/)){
    if(line===''){flush();continue}
    if(line.startsWith(':'))continue;
    if(line.startsWith('event:'))ev=line.slice(6).trim();
    else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
  }
  flush();return out;
}
function render(){
  const d=DATA[cur]; if(!d){pane.innerHTML='<div class="hint">empty</div>';return}
  if(tab==='summary'){
    const m=d.meta||{};
    pane.innerHTML='<pre>'+hl({id:d.dir,method:d.method,url:d.url,scope:d.scope,
      request:m.request&&{...m.request,preview:undefined},
      response:m.response?{...m.response,preview:undefined}:null})+'</pre>';
    return;
  }
  if(tab==='request'){pane.innerHTML='<pre>'+esc(d.requestText||'(no request body)')+'</pre>';return}
  if(tab==='raw'){pane.innerHTML='<pre>'+esc(d.requestText||'')+'\\n\\n--- response ---\\n'+(d.responseTruncated?'[truncated for viewer]\\n':'')+esc(d.responseText||'(no response body)')+'</pre>';return}
  if(!d.responseText){pane.innerHTML='<pre>'+esc(d.ws?JSON.stringify(d.meta&&d.meta.frames||[],null,2):'(no response body)')+'</pre>';return}
  if(d.stream){
    const evs=sseEvents(d.responseText);
    pane.innerHTML=evs.map((e,i)=>'<details class="ev"'+(i<3?' open':'')+'><summary>#'+i+(e.event?' ['+esc(e.event)+']':'')+'</summary><pre>'+hl(e.data)+'</pre></details>').join('')||'<div class="hint">empty stream</div>';
    return;
  }
  let parsed=null; try{parsed=JSON.parse(d.responseText)}catch{}
  pane.innerHTML='<pre>'+(parsed?hl(parsed):esc(d.responseText))+'</pre>';
}
renderList();renderTabs();render();
</script></body></html>`;

fs.writeFileSync(path.join(dir, 'viewer.html'), html);
fs.writeFileSync(path.join(dir, 'summary.txt'), summary.join('\n') + '\n');
console.log(`viewer:  ${path.join(dir, 'viewer.html')}  (${entries.length} exchange(s))`);
console.log(`summary: ${path.join(dir, 'summary.txt')}`);

if (wantOpen) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, [path.join(dir, 'viewer.html')], () => {});
}
