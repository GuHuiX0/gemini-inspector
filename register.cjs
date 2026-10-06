'use strict';

/**
 * Preload shim for gemini-cli.
 *
 * Node's --require only loads CommonJS, and gemini-cli's entry point is ESM,
 * so a bare `--require wiretap.mjs` would never run. This shim bridges that:
 * it is loaded first (CJS) and dynamically imports the real ESM hook.
 *
 *   NODE_OPTIONS="--require D:\codes\gemini-inspector\register.cjs"
 *
 * Only the child (real CLI) process is instrumented. The CLI relaunches itself
 * after allocating heap; the child inherits NODE_OPTIONS, which is why the hook
 * ends up in the process that actually talks to the model. Set
 * GEMINI_INSPECT_ALL_PROCS=1 to also instrument the parent launcher.
 */
if (process.env.GEMINI_INSPECT_ALL_PROCS === '1' || process.env.GEMINI_CLI_NO_RELAUNCH) {
  import('./wiretap.mjs').catch((err) => {
    process.stderr.write(`[inspector] failed to load hook: ${err && err.stack}\n`);
  });
}
