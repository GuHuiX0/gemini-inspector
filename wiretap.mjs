// gemini-inspector :: capture hook
//
// Everything gemini-cli sends to a model goes through the global `fetch`
// (the @google/genai client uses the global fetch as its transport, and
// `:streamGenerateContent?alt=sse` is consumed as an SSE body on that same
// fetch). Patching globalThis.fetch therefore sees the real wire payloads.
//
// This file is loaded by register.cjs via NODE_OPTIONS=--require.
//
// Environment:
//   GEMINI_WIRETAP_DIR      output directory      (default: <cwd>/.gemini-wiretap)
//   GEMINI_WIRETAP_SCOPE    all|google|model      (default: google)
//   GEMINI_WIRETAP_MAX      max body bytes kept   (default: 20000000)
//   GEMINI_WIRETAP_META     metadata preview size (default: 512)
//   GEMINI_WIRETAP_SELF     colon list of hosts to ignore (self/telemetry)
//   GEMINI_WIRETAP_VERBOSE  1 = mirror a status line to stderr
//   GEMINI_WIRETAP_WS       1 = also capture WebSocket (Live/bidi) frames

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  dir: path.join(process.cwd(), '.gemini-wiretap'),
  scope: 'google',
  max: 20_000_000,
  meta: 512,
  self: 'localhost:127.0.0.1:0.0.0.0:[::1]',
};

/** Prefer a relative path when the target sits under cwd; else absolute. */
function resolveDir(dir) {
  const abs = path.resolve(dir);
  const rel = path.relative(process.cwd(), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

const cfg = {
  dir: resolveDir(process.env.GEMINI_WIRETAP_DIR || DEFAULTS.dir),
  scope: process.env.GEMINI_WIRETAP_SCOPE || DEFAULTS.scope,
  max: Number(process.env.GEMINI_WIRETAP_MAX || DEFAULTS.max),
  meta: Number(process.env.GEMINI_WIRETAP_META || DEFAULTS.meta),
  self: (process.env.GEMINI_WIRETAP_SELF || DEFAULTS.self).split(':').filter(Boolean),
  verbose: process.env.GEMINI_WIRETAP_VERBOSE === '1',
};

// Model/generation calls, plus the Code Assist (OAuth login) control plane.
const GOOGLE_HOST = /(^|\.)(googleapis\.com|googleusercontent\.com|google\.com|gstatic\.com)$/i;
const MODEL_HINT =
  /generateContent|streamGenerateContent|countTokens|BidiGenerateContent|onboardUser|loadCodeAssist|retrieveUserQuota|recordCodeAssistMetrics|listExperiments|fetchAdminControls/i;
const SECRET_HEADER =
  /^(authorization|x-goog-api-key|x-api-key|proxy-authorization|cookie|set-cookie|x-goog-user-project)$/i;
const SECRET_QUERY = /^(key|access_token|id_token)$/i;

// ---------------------------------------------------------------- utilities

const nowIso = () => new Date().toISOString();

function redactValue(v) {
  const s = String(v ?? '');
  if (s.length <= 8) return '<redacted>';
  // ASCII only: keeps the dump readable in any console/encoding.
  return `<redacted:${s.slice(0, 4)}..${s.slice(-4)} len=${s.length}>`;
}

function redactUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_QUERY.test(k)) u.searchParams.set(k, redactValue(u.searchParams.get(k)));
    }
    return u.toString();
  } catch {
    return String(raw);
  }
}

function headerEntries(h) {
  if (!h) return [];
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    const out = [];
    h.forEach((v, k) => out.push([k, v]));
    return out;
  }
  if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)]);
  if (typeof h === 'object') return Object.entries(h).map(([k, v]) => [String(k), String(v)]);
  return [];
}

function redactedHeaders(source) {
  const out = {};
  for (const [k, v] of source) out[k] = SECRET_HEADER.test(k) ? redactValue(v) : v;
  return out;
}

function headerLookup(entries, name) {
  const want = name.toLowerCase();
  const hit = entries.find(([k]) => String(k).toLowerCase() === want);
  return hit ? String(hit[1]) : '';
}

const textEncoder = new TextEncoder();

/** Normalize anything fetch accepts as a request body into bytes. */
async function bodyToBytes(body, contentType) {
  if (body === undefined || body === null) return { bytes: null, kind: 'none' };
  if (typeof body === 'string') return { bytes: textEncoder.encode(body), kind: 'string' };
  if (body instanceof Uint8Array) return { bytes: body, kind: 'bytes' };
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return { bytes: new Uint8Array(await body.arrayBuffer()), kind: 'blob' };
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fields = [];
    for (const [k, v] of body.entries()) {
      fields.push(typeof v === 'string' ? k : `${k}=<${v?.name ?? 'file'}>`);
    }
    return { bytes: textEncoder.encode(JSON.stringify({ formDataFields: fields }, null, 2)), kind: 'formdata' };
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return { bytes: textEncoder.encode(body.toString()), kind: 'urlsearchparams' };
  }
  if (body && typeof body.getReader === 'function') {
    // ReadableStream request body: tee it so the real request is untouched.
    const [a, b] = body.tee();
    const reader = b.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return { bytes: concat(chunks), kind: 'stream', replacer: () => a };
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const c of body) chunks.push(typeof c === 'string' ? textEncoder.encode(c) : c);
    return { bytes: concat(chunks), kind: 'async-iterable' };
  }
  try {
    return { bytes: textEncoder.encode(JSON.stringify(body)), kind: 'json' };
  } catch {
    return { bytes: textEncoder.encode(`<unserializable ${contentType}>`), kind: 'unknown' };
  }
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Split SSE text into {event, data} records, decoding JSON data. */
function parseSse(text) {
  const events = [];
  let cur = { event: null, data: [] };
  const flush = () => {
    if (cur.event !== null || cur.data.length > 0) {
      const raw = cur.data.join('\n');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      events.push({ event: cur.event, data: parsed ?? raw });
    }
    cur = { event: null, data: [] };
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue; // comment / keep-alive
    if (line.startsWith('event:')) cur.event = line.slice(6).trim();
    else if (line.startsWith('data:')) cur.data.push(line.slice(5).replace(/^ /, ''));
  }
  flush();
  return events;
}

function sseSummary(events) {
  const parts = [];
  let text = '';
  for (const e of events) {
    const d = e.data;
    if (!d || typeof d !== 'object') continue;
    // Streaming frames carry text deltas, so accumulate across frames.
    const delta = d?.candidates?.[0]?.content?.parts?.map((p) => p?.text).filter(Boolean).join('');
    if (delta) text += delta;
    const finish = d?.candidates?.[0]?.finishReason;
    if (finish && finish !== 'FINISH_REASON_UNSPECIFIED') parts.push(`finish=${finish}`);
    if (d?.usageMetadata) parts.push(`usage=${JSON.stringify(d.usageMetadata)}`);
    if (d?.error) parts.push(`error=${JSON.stringify(d.error)}`);
  }
  return {
    eventCount: events.length,
    finishReasons: [...new Set(parts.filter((p) => p.startsWith('finish=')))],
    usage: parts.filter((p) => p.startsWith('usage=')).slice(-1)[0] ?? null,
    textPreview: text.slice(0, 200),
    textLength: text.length,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Model name. Plain Gemini/Vertex URLs carry it in the path; the Code Assist
 * (OAuth login) endpoint does not — there the model is a field of the request
 * body wrapper — so fall back to the body.
 */
function modelFrom(json, url) {
  const fromUrl = (() => {
    try {
      const m = new URL(url).pathname.match(/\/models\/([^:/]+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  })();
  if (fromUrl) return fromUrl;
  for (const c of [json?.model, json?.request?.model]) {
    if (typeof c === 'string' && c) return c;
  }
  return null;
}

/**
 * The CLI stamps its own session id into the request body. Shape differs by
 * backend, so probe the known locations:
 *   Code Assist / Vertex : { request: { session_id } } or { session_id }
 *   plain Gemini API     : { sessionId } (when present at all)
 * This is what makes multiple concurrent sessions distinguishable, since they
 * may share one capture directory.
 */
function sessionFromBody(json) {
  if (!json || typeof json !== 'object') return null;
  for (const candidate of [json?.request?.session_id, json?.session_id, json?.sessionId, json?.request?.sessionId]) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

/** Token counts: last usageMetadata in an SSE stream, or the JSON body. */
function extractUsage(sse, json) {
  if (json?.usageMetadata) return json.usageMetadata;
  if (sse) {
    for (let i = sse.length - 1; i >= 0; i--) {
      const d = sse[i]?.data;
      if (d && typeof d === 'object' && d.usageMetadata) return d.usageMetadata;
    }
  }
  return null;
}

// ------------------------------------------------------------------- state

let dirReady = false;

function ensureDir() {
  if (dirReady) return;
  fs.mkdirSync(cfg.dir, { recursive: true });
  dirReady = true;
}

function appendIndex(fields) {
  try {
    ensureDir();
    // Synchronous append on purpose: a WriteStream buffers, so a row could be
    // missing (or lost on crash) while the session is still running.
    fs.appendFileSync(path.join(cfg.dir, 'index.jsonl'), `${JSON.stringify({ t: nowIso(), engine: 'http', ...fields })}\n`);
  } catch {
    /* never break the CLI because of logging */
  }
}

function writeArtifact(name, text) {
  ensureDir();
  fs.writeFileSync(path.join(cfg.dir, name), text);
}

function classify(url) {
  try {
    const u = new URL(url);
    if (cfg.self.includes(u.hostname)) return 'self';
    if (GOOGLE_HOST.test(u.hostname)) return 'google';
    if (MODEL_HINT.test(u.pathname) || MODEL_HINT.test(u.href)) return 'model';
    return 'other';
  } catch {
    return 'other';
  }
}

function inScope(kind) {
  if (cfg.scope === 'all') return true;
  if (kind === 'self') return false;
  if (cfg.scope === 'google') return kind === 'google' || kind === 'model';
  if (cfg.scope === 'model') return kind === 'model';
  return kind === 'google' || kind === 'model';
}

const origFetch = globalThis.fetch;
let counter = 0;

function log(msg) {
  if (cfg.verbose) process.stderr.write(`[inspector] ${msg}\n`);
}

// --------------------------------------------------------------- archiving

function redactBytes(bytes, filename) {
  if (!bytes || bytes.length === 0) {
    return { archived: false, archiveFile: null, truncated: false, preview: '', note: 'empty body' };
  }
  let kept = bytes;
  let truncated = false;
  if (bytes.length > cfg.max) {
    kept = bytes.subarray(0, cfg.max);
    truncated = true;
  }
  const preview = Buffer.from(kept.subarray(0, Math.min(cfg.meta, kept.length))).toString('utf8');
  try {
    const archiveDir = path.join(cfg.dir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const archiveFile = path.join(archiveDir, filename);
    fs.writeFileSync(archiveFile, kept);
    return {
      archived: true,
      archiveFile,
      truncated,
      preview,
      note: truncated ? `truncated at GEMINI_WIRETAP_MAX=${cfg.max} of ${bytes.length}` : undefined,
    };
  } catch (err) {
    return { archived: false, archiveFile: null, truncated, preview, note: `archive failed: ${err}` };
  }
}

function relArchive(file) {
  if (!file) return null;
  return path.relative(cfg.dir, file).split(path.sep).join('/');
}

// ---------------------------------------------------------------- fetch hook

async function dumpCycle(url, init, method) {
  const id = `${Date.now().toString(36)}-${process.pid}-${++counter}`;
  const base = id.replace(/[^0-9A-Za-z_-]/g, '_');
  const urlText = typeof url === 'string' ? url : String(url?.url ?? url);
  const kind = classify(urlText);
  const redacted = redactUrl(urlText);
  const reqHeaders = redactedHeaders(headerEntries(init?.headers));
  const contentType = headerLookup(headerEntries(init?.headers), 'content-type');
  const startedAt = Date.now();

  let bytes = null;
  let bodyKind = 'none';
  let replacer = null;
  try {
    const b = await bodyToBytes(init?.body, contentType);
    bytes = b.bytes;
    bodyKind = b.kind;
    replacer = b.replacer ?? null;
  } catch (err) {
    log(`body read failed for ${redacted}: ${err}`);
  }
  const reqSize = redactBytes(bytes, `${base}.request.bin`);
  const reqJson = safeJson(bytes ? Buffer.from(bytes).toString('utf8') : '');

  const record = {
    id,
    engine: 'http',
    pid: process.pid,
    method,
    url: redacted,
    scope: kind,
    sessionId: sessionFromBody(reqJson),
    startedAt: new Date(startedAt).toISOString(),
    request: {
      headers: reqHeaders,
      contentType,
      bodyKind,
      bodyBytes: bytes ? bytes.length : 0,
      archived: reqSize.archived,
      archiveFile: relArchive(reqSize.archiveFile),
      truncated: reqSize.truncated,
      note: reqSize.note,
      preview: reqSize.preview,
    },
  };
  writeArtifact(`${base}.json`, JSON.stringify(record, null, 2));
  return { base, record, replacer, reqJson };
}

/** Patch global fetch so model request/response payloads can be inspected. */
function patchedFetch(url, init) {
  const initCopy = init ?? {};
  const method = String(initCopy.method || 'GET').toUpperCase();
  const urlText = typeof url === 'string' ? url : String(url?.url ?? url);
  const kind = classify(urlText);

  if (!inScope(kind)) return origFetch(url, init);
  if (kind === 'self' && !MODEL_HINT.test(urlText)) return origFetch(url, init);

  return (async () => {
    const cycle = await dumpCycle(url, initCopy, method);
    const callInit = { ...initCopy };
    if (cycle.replacer) callInit.body = cycle.replacer();
    const resp = await origFetch(url, callInit);
    // Mirror passively: the caller's own consumption drives the copy, so an
    // abandoned or failed stream can never keep this process alive, and the
    // response is never withheld from the caller.
    return mirrorResponse(cycle, resp, urlText, method);
  })();
}

function mirrorResponse(cycle, resp, urlText, method) {
  const respHeaders = redactedHeaders(headerEntries(resp.headers));
  const respCt = headerLookup(headerEntries(resp.headers), 'content-type');
  const isSse = /text\/event-stream/i.test(respCt) || /alt=sse/i.test(urlText);
  const meta = {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
    contentType: respCt,
    isStream: isSse,
  };

  if (!resp.body) {
    finalizeCycle(cycle, meta, null);
    return resp;
  }

  // Tee the body: one branch goes back to the caller untouched.
  const respCopy = resp.clone();
  const chunks = [];
  let total = 0;
  let finalized = false;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    // Release the tee's unused branch so neither side holds the process open.
    respCopy.body?.cancel?.().catch(() => {});
    finalizeCycle(cycle, meta, chunks.length ? concat(chunks) : null);
  };

  const ts = new TransformStream({
    transform(chunk, controller) {
      if (total < cfg.max) {
        const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        chunks.push(view);
        total += view.byteLength;
      }
      controller.enqueue(chunk);
    },
    flush() {
      finalize();
    },
    cancel() {
      finalize();
    },
  });

  const observed = new Response(resp.body.pipeThrough(ts), {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });

  // Safety net: if the caller abandons the body without cancelling, flush()
  // may never run. A one-shot listener records that without competing with the
  // caller for the stream.
  try {
    resp.body.addEventListener?.('close', finalize, { once: true });
    resp.body.addEventListener?.('error', finalize, { once: true });
  } catch {
    /* ignore */
  }

  return observed;
}

function finalizeCycle(cycle, meta, bytes) {
  const { base, record } = cycle;
  try {
    const all = bytes ?? new Uint8Array(0);
    const size = redactBytes(all, `${base}.response.bin`);
    const text = Buffer.from(all).toString('utf8');
    const sse = meta.isStream ? parseSse(text) : null;
    const json = meta.isStream ? null : safeJson(text);
    const usage = extractUsage(sse, json);

    record.response = {
      ...meta,
      bodyBytes: all.byteLength,
      archived: size.archived,
      archiveFile: relArchive(size.archiveFile),
      truncated: size.truncated,
      note: size.note,
      preview: meta.isStream
        ? (sse ? JSON.stringify(sseSummary(sse)) : '').slice(0, cfg.meta)
        : (json ? JSON.stringify(json) : size.preview).slice(0, cfg.meta),
      sseSummary: sse ? sseSummary(sse) : null,
      usage,
      durationMs: Date.now() - new Date(record.startedAt).getTime(),
    };
    record.model = modelFrom(cycle.reqJson, record.url);
    record.durationMs = record.response.durationMs;
    writeArtifact(`${base}.json`, JSON.stringify(record, null, 2));
    appendIndex({
      id: record.id,
      method: record.method,
      url: record.url,
      scope: record.scope,
      status: meta.status,
      model: record.model,
      sessionId: record.sessionId,
      pid: record.pid,
      stream: meta.isStream,
      reqBytes: record.request.bodyBytes,
      respBytes: all.byteLength,
      durationMs: record.durationMs,
      inputTokens: usage?.promptTokenCount ?? null,
      outputTokens: usage?.candidatesTokenCount ?? null,
      totalTokens: usage?.totalTokenCount ?? null,
      cachedTokens: usage?.cachedContentTokenCount ?? null,
      dir: base,
    });
    const label = record.url.replace(/^https?:\/\//, '').slice(0, 90);
    log(`${meta.status} ${record.method} ${label} in=${record.request.bodyBytes}B out=${all.byteLength}B`);
  } catch (err) {
    log(`response capture failed: ${err && err.message}`);
  }
}

// --------------------------------------------------------------- WebSocket

/** Live/bidi sessions use a WebSocket, not fetch. GEMINI_WIRETAP_WS=1 enables. */
function patchWebSocket() {
  if (process.env.GEMINI_WIRETAP_WS !== '1') return;
  const OrigWebSocket = globalThis.WebSocket;
  if (typeof OrigWebSocket !== 'function' || OrigWebSocket.__inspector) return;

  class InspectorWebSocket extends OrigWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      this.__wtUrl = String(url);
      const id = `${Date.now().toString(36)}-${process.pid}-${++counter}`;
      const dirName = id.replace(/[^0-9A-Za-z_-]/g, '_');
      const frames = [];
      const write = (direction, data) => {
        let text;
        try {
          if (typeof data === 'string') text = data;
          else if (data instanceof Uint8Array) text = Buffer.from(data).toString('utf8');
          else if (data instanceof ArrayBuffer) text = Buffer.from(new Uint8Array(data)).toString('utf8');
          else text = String(data);
        } catch {
          text = '<unreadable frame>';
        }
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        frames.push({ direction, at: nowIso(), sample: parsed ?? text.slice(0, 500) });
        writeArtifact(
          `${dirName}.ws.json`,
          JSON.stringify({ kind: 'websocket', url: redactUrl(this.__wtUrl), frames }, null, 2),
        );
      };
      this.addEventListener('open', () =>
        appendIndex({ id, url: redactUrl(this.__wtUrl), scope: classify(this.__wtUrl), ws: true, dir: dirName }),
      );
      this.addEventListener('message', (ev) => write('recv', ev.data));
      this.addEventListener('close', (ev) =>
        appendIndex({ id, url: redactUrl(this.__wtUrl), ws: true, closed: true, code: ev.code, dir: dirName }),
      );
      const send = this.send.bind(this);
      this.send = (data) => {
        write('send', data);
        return send(data);
      };
    }
  }
  InspectorWebSocket.__inspector = true;
  globalThis.WebSocket = InspectorWebSocket;
}

// -------------------------------------------------------------------- init

if (typeof origFetch === 'function') {
  globalThis.fetch = patchedFetch;
  patchWebSocket();
  ensureDir();
  log(`active pid=${process.pid} scope=${cfg.scope} dir=${cfg.dir}`);
} else {
  process.stderr.write('[inspector] global fetch not found; nothing patched\n');
}
