// Verifies scope classification/filtering with no network at all.
// Under the default scope=google, Google endpoints are captured and unrelated
// hosts are passed straight through untouched.
//
//   node test/scope-check.mjs
import fs from 'node:fs';
import path from 'node:path';

const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
};

const out = process.env.GEMINI_WIRETAP_DIR || './out-scopecheck';
fs.rmSync(out, { recursive: true, force: true });
process.env.GEMINI_WIRETAP_DIR = out;
process.env.GEMINI_WIRETAP_SCOPE = 'google';
process.env.GEMINI_WIRETAP_META = '64';

await import('../wiretap.mjs');

const cases = [
  ['gemini api', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=SECRET1234567890'],
  ['code assist (oauth)', 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'],
  ['vertex', 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/m:generateContent'],
  ['oauth token refresh', 'https://oauth2.googleapis.com/token'],
  ['unrelated host', 'https://example.com/x'],
];

for (const [label, url] of cases) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer SECRET' },
    body: '{"contents":[]}',
  });
  await res.text();
  process.stdout.write(`${label.padEnd(22)} reached-upstream=${calls.includes(url)}\n`);
}

const captured = fs.existsSync(path.join(out, 'index.jsonl'))
  ? fs
      .readFileSync(path.join(out, 'index.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l).url)
  : [];

process.stdout.write(`\ncaptured ${captured.length} exchange(s):\n${captured.map((u) => `  ${u}`).join('\n')}\n`);

const pass =
  captured.length === 4 && // all google hosts, but not example.com
  !captured.some((u) => u.includes('example.com')) &&
  captured.every((u) => !u.includes('SECRET1234567890')) &&
  captured.some((u) => u.includes('cloudcode-pa')) &&
  captured.some((u) => u.includes('alt=sse'));

process.stdout.write(pass ? '[test] PASS\n' : '[test] FAIL\n');
process.exit(pass ? 0 : 1);
