// Generate synthetic captures so the panel/viewer can be exercised without a
// real API key and without spending tokens.
//
//   node test/make-fake-captures.mjs ./out-demo 14
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || './out-demo');
const count = Number(process.argv[3] || 14);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });

const models = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash'];
const enc = new TextEncoder();
const indexLines = [];

for (let i = 0; i < count; i++) {
  const model = models[i % models.length];
  const stream = i % 3 !== 2;
  const id = `${Date.now().toString(36)}-${1000 + i}-${i + 1}`;
  const base = id.replace(/[^0-9A-Za-z_-]/g, '_');
  const startedAt = new Date(Date.now() - (count - i) * 1400);
  const inTok = 900 + i * 260; // context grows turn over turn
  const outTok = 60 + ((i * 37) % 400);
  const durationMs = 400 + ((i * 311) % 2600);
  const isError = i === count - 2;

  const request = JSON.stringify({
    contents: [
      { role: 'user', parts: [{ text: `turn ${i}: please refactor module ${i % 5}` }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: `src/m${i % 5}.ts` } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'x'.repeat(400 + i * 40) } } }] },
    ],
    tools: [{ functionDeclarations: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }] }],
  });

  const words = ['Analysing', 'the', 'module', 'and', 'proposing', 'a', 'refactor'];
  const sseFrames = words.map(
    (w, wi) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: (wi ? ' ' : '') + w }], role: 'model' } }] })}\n\n`,
  );
  sseFrames.push(
    `data: ${JSON.stringify({
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: inTok,
        candidatesTokenCount: outTok,
        totalTokenCount: inTok + outTok,
        cachedContentTokenCount: Math.round(inTok * 0.3),
      },
    })}\n\n`,
  );

  const responseBody = stream
    ? sseFrames.join('')
    : JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: inTok, candidatesTokenCount: outTok, totalTokenCount: inTok + outTok },
      });

  fs.writeFileSync(path.join(dir, 'archive', `${base}.request.bin`), request);
  fs.writeFileSync(path.join(dir, 'archive', `${base}.response.bin`), responseBody);

  const url = `https://cloudcode-pa.googleapis.com/v1internal:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}?key=<redacted:AIza..9f2c len=39>`;
  const status = isError ? 429 : 200;

  const record = {
    id,
    engine: 'http',
    pid: 4242,
    method: 'POST',
    url,
    scope: 'google',
    startedAt: startedAt.toISOString(),
    model,
    durationMs,
    request: {
      headers: { 'content-type': 'application/json', authorization: '<redacted:Bear..9f2c len=39>' },
      contentType: 'application/json',
      bodyKind: 'string',
      bodyBytes: enc.encode(request).length,
      archived: true,
      archiveFile: `archive/${base}.request.bin`,
      truncated: false,
      preview: request.slice(0, 512),
    },
    response: {
      status,
      statusText: isError ? 'Too Many Requests' : 'OK',
      headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' },
      contentType: stream ? 'text/event-stream' : 'application/json',
      isStream: stream,
      bodyBytes: enc.encode(responseBody).length,
      archived: true,
      archiveFile: `archive/${base}.response.bin`,
      truncated: false,
      usage: isError ? null : { promptTokenCount: inTok, candidatesTokenCount: outTok, totalTokenCount: inTok + outTok },
      sseSummary: stream
        ? { eventCount: sseFrames.length, finishReasons: ['finish=STOP'], usage: null, textPreview: words.join(' '), textLength: words.join(' ').length }
        : null,
      durationMs,
    },
  };
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(record, null, 2));

  indexLines.push(
    JSON.stringify({
      t: startedAt.toISOString(),
      engine: 'http',
      id,
      method: 'POST',
      url,
      scope: 'google',
      status,
      model,
      stream,
      reqBytes: record.request.bodyBytes,
      respBytes: record.response.bodyBytes,
      durationMs,
      inputTokens: isError ? null : inTok,
      outputTokens: isError ? null : outTok,
      totalTokens: isError ? null : inTok + outTok,
      cachedTokens: isError ? null : Math.round(inTok * 0.3),
      dir: base,
    }),
  );
}

fs.writeFileSync(path.join(dir, 'index.jsonl'), indexLines.join('\n') + '\n');
process.stdout.write(`[fake] wrote ${count} captures to ${dir}\n`);
