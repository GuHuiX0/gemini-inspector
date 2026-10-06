// Shows exactly what a capture directory contains, using a realistic
// Code Assist (OAuth login) shaped exchange. No network, no tokens.
import fs from 'node:fs';
import path from 'node:path';

const out = './out-what';
fs.rmSync(out, { recursive: true, force: true });
process.env.GEMINI_WIRETAP_DIR = out;
process.env.GEMINI_WIRETAP_SCOPE = 'google';
process.env.GEMINI_WIRETAP_META = '256';

const encoder = new TextEncoder();

// A request body with the same shape gemini-cli actually sends on Code Assist:
// wrapper { model, project, user_prompt_id, request: { contents, systemInstruction, tools, session_id } }
const requestBody = JSON.stringify({
  model: 'gemini-2.5-pro',
  project: 'my-gcp-project',
  user_prompt_id: 'prompt-7f3a',
  request: {
    contents: [
      { role: 'user', parts: [{ text: 'Add a --verbose flag to the CLI entry point.' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'src/cli.ts' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'export function main() { /* ... */ }' } } }] },
    ],
    systemInstruction: { parts: [{ text: 'You are a careful coding agent. Never run destructive commands.' }] },
    tools: [
      {
        functionDeclarations: [
          { name: 'read_file', description: 'Read a file from disk', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
          { name: 'run_shell_command', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
        ],
      },
    ],
    generationConfig: { temperature: 1, maxOutputTokens: 8192 },
    session_id: 'a1b2c3d4-1111-4000-8000-aaaaaaaaaaaa',
  },
});

const sse = [
  `data: {"candidates":[{"content":{"parts":[{"text":"I will"}],"role":"model"}}]}`,
  `data: {"candidates":[{"content":{"parts":[{"text":" add the flag."}],"role":"model"}}]}`,
  `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"src/cli.ts"}}}]}}]}`,
  `data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":18432,"candidatesTokenCount":121,"totalTokenCount":18553,"cachedContentTokenCount":16000}}`,
].map((l) => l + '\n\n').join('');

globalThis.fetch = async () =>
  new Response(
    new ReadableStream({
      start(c) {
        // Chunk mid-frame on purpose: proves frames are reassembled, not naively split.
        const bytes = encoder.encode(sse);
        c.enqueue(bytes.slice(0, 60));
        c.enqueue(bytes.slice(60, 180));
        c.enqueue(bytes.slice(180));
        c.close();
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-goog-request-id': 'req-4b91',
        'x-gemini-service-tier': 'standard',
      },
    },
  );

await import('../wiretap.mjs');

const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ya29.a0AfH6SMBxSECREToAuthAccessTokenValue1234567890',
    'x-goog-api-client': 'gl-node/24.13.1',
    'user-agent': 'GeminiCLI/0.62.0/gemini-2.5-pro (win32; x64)',
  },
  body: requestBody,
});
let got = '';
for await (const c of res.body) got += Buffer.from(c).toString('utf8');
await new Promise((r) => setTimeout(r, 250));

// ------------------------------------------------------------------ report

const walk = (dir, prefix = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      console.log(`${prefix}${e.name}/`);
      walk(p, `${prefix}  `);
    } else {
      console.log(`${prefix}${e.name}  (${fs.statSync(p).size} bytes)`);
    }
  }
};

console.log('\n=== 目录结构 ===');
walk(out);

const recFile = fs.readdirSync(out).find((f) => f.endsWith('.json') && !f.startsWith('index'));
const base = recFile.replace(/\.json$/, '');

console.log('\n=== index.jsonl（每笔一行，面板只读这个）===');
console.log(fs.readFileSync(path.join(out, 'index.jsonl'), 'utf8').trim());

console.log('\n=== <id>.json（完整记录；此处只打印 request/response 的元数据）===');
const rec = JSON.parse(fs.readFileSync(path.join(out, recFile), 'utf8'));
console.log(JSON.stringify({ ...rec, request: { ...rec.request, preview: '<省略>' }, response: { ...rec.response, preview: '<省略>' } }, null, 2));

console.log('\n=== archive/request.bin：完整请求体（未截断，原样字节）===');
const reqText = fs.readFileSync(path.join(out, 'archive', `${base}.request.bin`), 'utf8');
const reqJson = JSON.parse(reqText);
console.log('顶层键              :', Object.keys(reqJson).join(', '));
console.log('request 内层键      :', Object.keys(reqJson.request).join(', '));
console.log('systemInstruction   :', JSON.stringify(reqJson.request.systemInstruction));
console.log('tools 里的函数名    :', reqJson.request.tools[0].functionDeclarations.map((f) => f.name).join(', '));
console.log('contents 轮数       :', reqJson.request.contents.length);
console.log('session_id          :', reqJson.request.session_id);
console.log('全文大小            :', reqText.length, 'bytes');

console.log('\n=== archive/response.bin：原始 SSE 字节（分块边界原样保留）===');
const respText = fs.readFileSync(path.join(out, 'archive', `${base}.response.bin`), 'utf8');
console.log('大小                :', respText.length, 'bytes');
console.log('SSE 帧数            :', respText.split('\n\n').filter((s) => s.trim()).length);
console.log('usageMetadata 解析  :', JSON.stringify(rec.response.usage));

console.log('\n=== 凭证处理 ===');
console.log('authorization 存档值:', rec.request.headers.authorization);
console.log('原始 token 是否落盘  :', fs.readdirSync(out, { recursive: true }).some((f) => {
  const p = path.join(out, String(f));
  return fs.statSync(p).isFile() && fs.readFileSync(p, 'latin1').includes('SECREToAuthAccessTokenValue');
}));
