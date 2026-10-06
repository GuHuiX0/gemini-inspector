// Deterministic full-cycle test: a stubbed fetch returns a real streaming
// Response, so request + response + SSE archiving are exercised without any
// network and without burning tokens.
//
//   node test/stream-check.mjs
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.GEMINI_WIRETAP_DIR || './out-streamcheck';
fs.rmSync(out, { recursive: true, force: true });
process.env.GEMINI_WIRETAP_DIR = out;
process.env.GEMINI_WIRETAP_SCOPE = 'google';
process.env.GEMINI_WIRETAP_VERBOSE = '1';

const encoder = new TextEncoder();
globalThis.fetch = async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const frames = [
          'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
          'data: {"usageMetadata":{"totalTokenCount":9}}\n\n',
          'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
        ];
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-goog-request-id': 'abc123' } },
  );

await import('../wiretap.mjs');

const key = 'SECRETKEY1234567890';
const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=${key}`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }),
  },
);

// Caller must consume the stream exactly as the CLI does.
let text = '';
for await (const chunk of res.body) text += Buffer.from(chunk).toString('utf8');
process.stdout.write(`[test] caller received ${text.length} bytes, status=${res.status}\n`);

await new Promise((r) => setTimeout(r, 300)); // let the fire-and-forget capture flush

const recFile = fs.readdirSync(out).find((f) => f.endsWith('.json') && !f.startsWith('index'));
const record = JSON.parse(fs.readFileSync(path.join(out, recFile), 'utf8'));
const respBin = fs.readdirSync(path.join(out, 'archive')).find((f) => f.includes('response'));
const binText = fs.readFileSync(path.join(out, 'archive', respBin), 'utf8');

process.stdout.write(`[test] archived response bytes=${binText.length}\n`);
process.stdout.write(`[test] sseSummary=${JSON.stringify(record.response.sseSummary)}\n`);
process.stdout.write(`[test] model=${record.model} url=${record.url}\n`);
process.stdout.write(`[test] auth header recorded as: ${record.request.headers.authorization}\n`);

const ok =
  text.length === 220 &&
  binText.length === 220 &&
  record.response.sseSummary?.textPreview === 'Hello' &&
  record.response.sseSummary?.textLength === 5 &&
  record.model === 'gemini-2.5-pro' &&
  record.url.includes('redacted') &&
  record.request.headers.authorization.includes('redacted');

process.stdout.write(ok ? '[test] PASS\n' : '[test] FAIL\n');
process.exit(ok ? 0 : 1);
