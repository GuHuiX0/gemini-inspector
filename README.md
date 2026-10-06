# gemini-inspector

See exactly what **gemini-cli** sends to and receives from the model: the full
request body (system prompt, tools, conversation history), the raw response, and
every SSE frame — plus a live dashboard with latency, token, context-growth and
cost metrics.

Works with **API-key and account (OAuth) login**, because both paths go through
the same global `fetch` inside the CLI process.

Nothing here patches gemini-cli. It is an external hook loaded via
`NODE_OPTIONS`, so a gemini-cli update cannot delete it and it survives
reinstalls.

---

## Files

| File | Role |
|---|---|
| `register.cjs` | **Entry point.** Loaded first by `NODE_OPTIONS=--require`. Node's `--require` only loads CommonJS, and gemini-cli's entry is ESM, so this shim exists purely to `import()` the real hook. |
| `wiretap.mjs` | **The hook.** Replaces `globalThis.fetch`, captures request + response bodies, redacts secrets, parses SSE, appends `index.jsonl`, archives bodies under `archive/`. Optionally captures WebSocket frames. |
| `panel.mjs` | **Live dashboard.** A separate process that tails the capture directory and serves a Grafana-style panel (stat cards, charts, model/cost tables, per-request drawer). Never runs inside the CLI. |
| `genview.mjs` | **Offline viewer.** Turns a capture directory into a self-contained `viewer.html` plus a greppable `summary.txt`. No server needed. |
| `package.json` | Marks the directory ESM and provides `npm run panel` / `npm run view` / `npm test`. |
| `test/stream-check.mjs` | Self-test: streaming/SSE capture, delta accumulation, redaction. No network. |
| `test/unary-check.mjs` | Self-test: non-streaming response + HTTP error path (429, `retry-after`). No network. |
| `test/scope-check.mjs` | Self-test: only Google/Vertex endpoints are captured; unrelated hosts pass through untouched. No network. |
| `test/cli-preload-check.mjs` | Self-test against the real bundle layout: proves the hook is installed and captures a Code Assist (`cloudcode-pa`) shaped SSE call. No network. |
| `test/entry-probe.mjs` | Diagnostic: prints whether the preload reached this process and whether `fetch` is patched. |
| `test/make-fake-captures.mjs` | Generates synthetic captures so you can try the panel/viewer with zero API traffic. |

Captures are written to `<dir>/` (`index.jsonl` + `<id>.json` + `archive/*.bin`).
Default dir is `./.gemini-wiretap` in the current working directory. **Secrets in
headers and query strings are redacted by default** — but treat capture
directories as sensitive anyway, since they contain your full prompts and code.

---

## Deploying on a machine

**Requirements:** Node.js ≥ 20 (the CLI already needs it). No `npm install`, no
dependencies.

### 1. Copy the directory

Anywhere stable that is **not** inside gemini-cli's install directory (an update
would delete it). For example `D:\codes\gemini-inspector` or `%USERPROFILE%\tools\gemini-inspector`.

### 2. Verify the installation (no tokens spent)

```powershell
cd D:\codes\gemini-inspector
npm test          # or: node test/stream-check.mjs (etc.)
```

Each test prints `[test] PASS`.

### 3. Point the CLI at the hook

The easiest way is the bundled setup script (dot-source it so the variables land
in your session):

```powershell
cd D:\codes\gemini-inspector
. .\setup.ps1 -Dir D:\captures\gemini -Log
gemini
```

Undo with `. .\setup.ps1 -Unset`.

### What `setup.ps1` does and does not touch

It is **session-volatile**. It only sets process-level environment variables:

- **Does not** write the registry, `setx`, or User/Machine environment — nothing
  survives the terminal closing;
- **Does not** modify gemini-cli or any file outside the capture directory;
- Child processes spawned from that terminal **do** inherit the variables — that
  is exactly how the hook reaches gemini-cli;
- A newly opened terminal window is **not** instrumented until you arm it again;
- `-Unset` **restores** any pre-existing `NODE_OPTIONS` (it saves the original
  before overwriting, and repeat arming will not clobber the saved copy). Running
  `-Unset` without having armed changes nothing.

So: closing the terminal is always a safe, complete undo.

Or set them by hand:

```powershell
$env:NODE_OPTIONS       = "--require D:\codes\gemini-inspector\register.cjs"
$env:GEMINI_WIRETAP_DIR = "D:\captures\gemini"      # optional; anywhere writable
gemini
```

That is the whole setup. Works for interactive sessions and for `gemini -p "..."`.

> ### ⚠ Two path requirements — read these, they fail silently
>
> **Do not quote the path in `NODE_OPTIONS`.** Node's parser strips the quotes and
> glues the path together, producing an unrecoverable path:
> `"--require D:\codes\gemini-inspector\register.cjs"` →
> `Cannot find module 'D:codesgemini-inspectorregister.cjs'`.
> The hook then never loads, and gemini-cli quietly runs un-instrumented.
>
> **The path must be ASCII-only.** A path containing non-ASCII characters
> (for example `C:\Users\顾惠\...`) cannot be resolved through `NODE_OPTIONS` at
> all — `register.cjs` fails to load. This is why the tool lives at
> `D:\codes\gemini-inspector` and not inside the CLI's install directory under
> your user profile. Spaces are also risky; avoid them.
>
> If you are unsure, verify with:
> `node --require <path>\register.cjs test/entry-probe.mjs` → must print
> `fetch is patched=true`.

> **Note:** `NODE_OPTIONS` is inherited by *every* Node process started from
> that terminal, so it also affects other Node tools while it is set. Set it only
> in the terminal used for inspecting, or clear it afterwards with
> `Remove-Item Env:\NODE_OPTIONS`.

### 4. Watch it live

In a second terminal:

```powershell
cd D:\codes\gemini-inspector
node panel.mjs --dir D:\captures\gemini
```

Opens `http://127.0.0.1:5099` automatically. `--dir` **must match**
`GEMINI_WIRETAP_DIR`. Use the panel while gemini runs in the first terminal:
rows appear within ~1s and the console prints a running token/cost total.

Or produce a static report afterwards:

```powershell
node genview.mjs --dir D:\captures\gemini --open
```

---

## Configuration

All optional; set them alongside `NODE_OPTIONS`.

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_WIRETAP_DIR` | `./.gemini-wiretap` | Where captures are written. |
| `GEMINI_WIRETAP_SCOPE` | `google` | `google` = Google/Vertex hosts; `model` = only paths containing `generateContent`/`countTokens`/… (drops OAuth token refreshes); `all` = everything. |
| `GEMINI_WIRETAP_VERBOSE` | off | `1` prints one `[inspector] …` line per exchange to stderr, plus an `active pid=…` line at load. **Use this first when nothing is captured.** |
| `GEMINI_WIRETAP_MAX` | `20000000` | Max bytes archived per body. |
| `GEMINI_WIRETAP_META` | `512` | Preview size stored in the record metadata. |
| `GEMINI_WIRETAP_SELF` | localhost list | Hosts never captured. |
| `GEMINI_WIRETAP_WS` | off | `1` also records Live/bidi WebSocket frames to `<id>.ws.json`. |
| `GEMINI_INSPECT_ALL_PROCS` | off | `1` also instruments the launcher process (normally only the real CLI child is instrumented). |
| `GEMINI_INSPECT_PORT` | `5099` | Panel port. |

---

## Verifying it works on a new machine

**Step 1 — did the hook load?** Run gemini once with verbose on:

```powershell
$env:GEMINI_WIRETAP_VERBOSE = "1"
gemini -p "hi"
```

Look for `[inspector] active pid=… dir=…`. If that line never appears, the
preload did not reach the CLI process:

- confirm the `register.cjs` path in `NODE_OPTIONS` is correct and absolute;
- confirm a `--require` CJS shim is used (not `--import`);
- on the machine's Node, check `node --require <path>\register.cjs test/entry-probe.mjs`
  prints `fetch is patched=true`.

**Step 2 — is traffic captured?** With verbose on you should also see one
`[inspector] 200 POST <host>…` line per model call. Note that with **account
login** the host is `cloudcode-pa.googleapis.com` (Code Assist control plane),
not `generativelanguage.googleapis.com` — both are captured by the default scope.

**Step 3 — is the payload right?**

```powershell
Get-Content D:\captures\gemini\index.jsonl | ConvertFrom-Json |
  Select-Object model,status,stream,durationMs,inputTokens,outputTokens,url | Format-List
$id = (Get-Content D:\captures\gemini\index.jsonl -TotalCount 1 | ConvertFrom-Json).dir
Get-Content "D:\captures\gemini\archive\$id.request.bin" -Raw | ConvertFrom-Json |
  Select-Object -ExpandProperty systemInstruction
```

`model`/`inputTokens` populated means `usageMetadata` was parsed (needed for the
panel's cost and trend charts). Secrets should appear as `<redacted:AIza..9f2c len=39>`.

---

## What the panel shows

- **Stat cards** — exchanges, error rate, p50/p95/max latency, input/output
  tokens, estimated cost, bytes in/out.
- **Requests / 10s** and **Tokens / 10s** stacked bar charts (errors in red).
- **Models** table — requests, tokens, cost, errors per model.
- **Heaviest request bodies** — the most direct view of **context growth**; if a
  session gets expensive, look here first.
- **Exchanges** table — sortable/filterable; click any row for a drawer with
  `summary` / `request` / `response` / `raw` tabs. Streamed responses are parsed
  into individually collapsible SSE frames.

### Cost estimates

`panel.mjs` contains a hardcoded USD-per-1M-token table (`PRICING`). It is an
**estimate and may be stale** — verify against current Google pricing and edit
that table. Models not in the table are reported as `n/a` and the card shows
"partial (unpriced models)" rather than guessing.

---

## Limitations

- **`NODE_OPTIONS` is process-wide.** While set, it applies to every Node process
  in that terminal.
- **Live/bidi (WebSocket) needs `GEMINI_WIRETAP_WS=1`** and was not verified
  end-to-end on this machine.
- **A capture directory contains your full prompts and file contents.** Redaction
  covers credentials only. Do not commit or share it carelessly.
- Report bodies are capped by `GEMINI_WIRETAP_MAX` (truncation is recorded in the
  record's `note` field).
- Requires the CLI to keep using the global `fetch` as its model transport. If a
  future version switches transports, `[inspector] active` will still print but
  no exchanges will appear — that is the signal to re-check.
