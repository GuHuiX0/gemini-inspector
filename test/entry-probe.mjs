// Proves the preload actually reached the process that talks to the model, and
// dumps the environment facts you need when it did not.
//
//   node --require D:\codes\gemini-inspector\register.cjs test/entry-probe.mjs
//
// Loaded through the same --require path the CLI uses, so a missing
// "[inspector] active" line here means the preload never ran.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.GEMINI_WIRETAP_DIR;
const archiveDir = dir ? path.join(path.resolve(dir), 'archive') : null;

process.stdout.write(`[probe] pid=${process.pid}\n`);
process.stdout.write(`[probe] NODE_OPTIONS=${JSON.stringify(process.env.NODE_OPTIONS || '')}\n`);
process.stdout.write(`[probe] GEMINI_WIRETAP_DIR=${dir}\n`);
process.stdout.write(`[probe] child-process marker GEMINI_CLI_NO_RELAUNCH=${process.env.GEMINI_CLI_NO_RELAUNCH || '(unset)'}\n`);
process.stdout.write(`[probe] capture dir exists=${dir ? fs.existsSync(path.resolve(dir)) : false}\n`);
process.stdout.write(`[probe] archive dir exists=${archiveDir ? fs.existsSync(archiveDir) : false}\n`);
process.stdout.write(`[probe] fetch is patched=${globalThis.fetch?.name === 'patchedFetch'}\n`);
