// Non-streaming response + HTTP error path coverage.
//
//   node test/unary-check.mjs
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.GEMINI_WIRETAP_DIR || './out-unarycheck';
fs.rmSync(out, { recursive: true, force: true });
process.env.GEMINI_WIRETAP_DIR = out;
process.env.GEMINI_WIRETAP_SCOPE = 'google';
process.env.GEMINI_WIRETAP_VERBOSE = '1';

globalThis.fetch = async (url) => {
  if (String(url).includes('error')) {
    return new Response(
      JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' } },
    );
  }
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

await import('../wiretap.mjs');

const ok = await fetch('https://generativelanguage.googleapis.com/v1beta/models/m:generateContent', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ contents: [] }),
});
const okBody = JSON.stringify(await ok.json());

const bad = await fetch('https://generativelanguage.googleapis.com/v1beta/models/m:generateContent/error');
const badText = await bad.text();

await new Promise((r) => setTimeout(r, 300));

const records = fs
  .readdirSync(out)
  .filter((f) => f.endsWith('.json') && !f.startsWith('index'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')));

for (const r of records) {
  process.stdout.write(
    `[test] record status=${r.response.status} bodyBytes=${r.response.bodyBytes} ` +
      `usage=${JSON.stringify(r.response.usage)} preview=${JSON.stringify(r.response.preview)}\n`,
  );
}

const good = records.find((r) => r.response.status === 200);
const err = records.find((r) => r.response.status === 429);
const pass =
  ok.status === 200 &&
  bad.status === 429 &&
  bad.headers.get('retry-after') === '5' &&
  records.length === 2 &&
  good?.response.usage?.totalTokenCount === 15 &&
  err?.response.headers['retry-after'] === '5' &&
  err?.response.preview.includes('RESOURCE_EXHAUSTED') &&
  okBody.includes('"ok"') &&
  badText.includes('quota');

process.stdout.write(pass ? '[test] PASS\n' : '[test] FAIL\n');
process.exit(pass ? 0 : 1);
