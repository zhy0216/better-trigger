/* =============================================================================
   better-trigger — edge import: the SDK must load and trigger WITHOUT
   node:async_hooks (p1-16).

   AsyncLocalStorage is fetched lazily via `process.getBuiltinModule` (then a
   free `require`, then undefined). The promise is that `import 'better-trigger'`
   works in edge / browser / pure-ESM apps where neither exists — there is no
   in-flight task in such a process, so `currentExecutor()` correctly reads
   undefined and the app-side trigger path goes straight over HTTP.

   Why this is a child-process test and not a `vi.stubGlobal('process', ...)`
   one: under `bunx vitest` (bun's runtime) a free `require` EXISTS in every
   module scope, so stubbing process.getBuiltinModule away still lets the
   loader's `require('node:async_hooks')` fallback find a real ALS — the stub
   could never produce `undefined` there. Spawning `node` (real ESM, no
   `require`) isolates each case in a fresh process whose module cache is empty
   and whose `typeof require === 'undefined'`, so removing getBuiltinModule
   genuinely leaves NO path to AsyncLocalStorage. Same approach as
   apps/worker/test/crash.test.ts: drive a real process, assert on stdout/exit.

   The built dist (packages/sdk/dist/index.js) exercises the shipped artifact;
   the loader-level cases import src/als.ts directly (Node 24 strips types, and
   als.ts has no runtime imports).

   Positive control: with the real process (getBuiltinModule present), the
   lazy load finds AsyncLocalStorage and `getExecutorStorage()` is a function —
   and test/task.test.ts's `executorStorage!.run(executor, ...)` harness
   (p1-15) proves ctx detection works end-to-end when the storage IS there.
   ============================================================================= */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const ALS_ENTRY = fileURLToPath(new URL('../src/als.ts', import.meta.url));
const SDK_INDEX = fileURLToPath(new URL('../dist/index.js', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run an inline ESM script under real Node, where `require` does not exist. */
function runNode(script: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', script], {
      env: { ...process.env, ALS_ENTRY, SDK_INDEX },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    // A wedged script would otherwise hang the suite.
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A script passes when it prints OK and exits 0; failures throw and exit 1. */
async function expectOK(script: string, label: string): Promise<void> {
  const { code, stdout, stderr } = await runNode(script);
  expect(stderr, `${label}: unexpected stderr`).not.toMatch(/\bError:/);
  expect(stdout, `${label}: expected the script to reach its OK line`).toContain('OK');
  expect(code, `${label}: expected exit 0`).toBe(0);
}

describe('loader-level: getExecutorStorage() without node:async_hooks', () => {
  it(
    'no process.getBuiltinModule (and no require in real Node ESM) → undefined',
    async () => {
      await expectOK(
        `globalThis.process = { ...process, getBuiltinModule: undefined };
         const als = await import('file://' + process.env.ALS_ENTRY);
         if (als.getExecutorStorage() !== undefined)
           throw new Error('getExecutorStorage should be undefined without getBuiltinModule');
         console.log('OK');`,
        'no getBuiltinModule',
      );
    },
  );

  it(
    'a throwing process.getBuiltinModule is caught → undefined',
    async () => {
      await expectOK(
        `globalThis.process = {
           ...process,
           getBuiltinModule: () => { throw new Error('no node builtins here'); },
         };
         const als = await import('file://' + process.env.ALS_ENTRY);
         if (als.getExecutorStorage() !== undefined)
           throw new Error('a throwing getBuiltinModule must be caught, yielding undefined');
         console.log('OK');`,
        'throwing getBuiltinModule',
      );
    },
  );
});

describe('import-level: the SDK loads and the app trigger path works on the edge', () => {
  it(
    'import of the built SDK succeeds, no executor storage, trigger over HTTP',
    async () => {
      if (!existsSync(SDK_INDEX)) {
        throw new Error(
          'packages/sdk/dist/index.js is missing — run "bun run build --filter=better-trigger" first',
        );
      }
      await expectOK(
        `globalThis.process = { ...process, getBuiltinModule: undefined };
         const { pathToFileURL } = await import('node:url');
         const mod = await import(pathToFileURL(process.env.SDK_INDEX).href);
         const { executorStorage, currentExecutor } =
           await import(pathToFileURL(process.env.SDK_INDEX.replace(/index\\.js$/, 'internal.js')).href);
         if (executorStorage() !== undefined)
           throw new Error('executorStorage must be undefined on the edge');
         if (currentExecutor() !== undefined)
           throw new Error('currentExecutor must be undefined on the edge');
         const fetchMock = async (url, init) => {
           const body = JSON.parse(init.body);
           if (String(url).endsWith('/api/v1/trigger') && init.method === 'POST'
               && body.taskId === 'edge_task' && body.payload?.n === 1) {
             return new Response(
               JSON.stringify({ runId: 'run_edge_ok' }),
               { status: 200, headers: { 'content-type': 'application/json' } },
             );
           }
           throw new Error('unexpected request: ' + url + ' ' + init.method);
         };
         const bt = mod.betterTrigger({ url: 'http://edge-host', fetch: fetchMock });
         const handle = await bt.trigger('edge_task', { n: 1 });
         if (handle.id !== 'run_edge_ok')
           throw new Error('trigger did not return the mocked run handle: ' + handle.id);
         console.log('OK');`,
        'edge import + trigger',
      );
    },
  );
});

describe('positive control', () => {
  it(
    'with the real process, the lazy load finds AsyncLocalStorage on Node',
    async () => {
      await expectOK(
        `const als = await import('file://' + process.env.ALS_ENTRY);
         if (typeof als.getExecutorStorage() !== 'function')
           throw new Error('real Node must expose AsyncLocalStorage');
         console.log('OK');`,
        'real-Node positive control',
      );
    },
  );

  it(
    'in the normal (bunx vitest) environment, getExecutorStorage() is a function',
    async () => {
      vi.resetModules();
      const { getExecutorStorage } = await import('../src/als');
      expect(typeof getExecutorStorage()).toBe('function');
      // ctx detection with the storage present is proven by the in-run harness
      // in test/task.test.ts ("durable in-run trigger", p1-15): it drives the
      // app-side handle under `executorStorage!.run(executor, ...)` and asserts
      // the durable step fires — the counterexample to the edge path above.
    },
  );
});
