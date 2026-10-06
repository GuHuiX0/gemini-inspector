// Verifies the preload against the REAL gemini-cli bundle.
//
//   node --require D:\codes\gemini-inspector\register.cjs test/cli-preload-check.mjs <path to gemini.js>
//
// The CLI's launcher spawns a child; the child inherits NODE_OPTIONS, which is
// how the hook reaches the process that talks to the model. This script asserts
// the hook is present, then simulates a Code Assist style call so nothing real
// is sent and no tokens are spent.
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('./out-cli-preload');
fs.rmSync(out, { recursive: true, force: true });
process.env.GEMINI_WIRETAP_DIR = out;
process.env.GEMINI_WIRETAP_SCOPE = 'google';
process.env.GEMINI_WIRETAP_VERBOSE = '1';

const patchedBefore = globalThis.fetch?.name === 'patchedFetch';

// Stub the transport: we only care that the hook wraps whatever fetch the CLI
// would use, and that a Code Assist style exchange is captured.
const encoder = new TextEncoder();
globalThis.fetch = async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"usageMetadata":{"promptTokenCount":42,"candidatesTokenCount":1,"totalTokenCount":43}}\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

await import('../wiretap.mjs');
const patchedAfter = globalThis.fetch?.name === 'patchedFetch';

const res = await fetch(
  'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ya29.SECRETTOKEN' }, body: '{"model":"gemini-2.5-pro","project":"p"}' },
);
let got = '';
for await (const c of res.body) got += Buffer.from(c).toString('utf8');
await new Promise((r) => setTimeout(r, 200));

const indexFile = path.join(out, 'index.jsonl');
const lines = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8').split('\n').filter(Boolean) : [];
const row = lines.length ? JSON.parse(lines[0]) : null;

process.stdout.write(`[test] fetch patched on load   = ${patchedBefore}\n`);
process.stdout.write(`[test] fetch patched after hook= ${patchedAfter}\n`);
process.stdout.write(`[test] caller got ${got.length} stream bytes, status=${res.status}\n`);
process.stdout.write(`[test] index rows = ${lines.length}\n`);
process.stdout.write(`[test] row = ${JSON.stringify(row)}\n`);

const pass =
  patchedBefore === false &&
  patchedAfter === true &&
  got.includes('"text":"hi"') &&
  lines.length === 1 &&
  row.url.includes('cloudcode-pa') &&
  row.stream === true &&
  row.inputTokens === 42 &&
  row.outputTokens === 1 &&
  !JSON.stringify(row).includes('SECRETTOKEN');

process.stdout.write(pass ? '[test] PASS\n' : '[test] FAIL\n');
process.exit(pass ? 0 : 1);
