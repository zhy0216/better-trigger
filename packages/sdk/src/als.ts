/* =============================================================================
   better-trigger — lazy AsyncLocalStorage access (p1-16).

   The SDK imports cleanly in edge / browser / any non-Node runtime — the
   "zero runtime dependencies, safe to import" promise — so the ONLY thing that
   needs `node:async_hooks` (AsyncLocalStorage, used to detect "am I inside a
   running task?") must not be imported at module load. It is fetched lazily,
   once, on first use:

     - `process.getBuiltinModule('node:async_hooks')` — synchronous, available
       on Node 22.3+ AND bun (the daemon's runtime), works in ESM and CJS.
     - fallback `require('node:async_hooks')` — older Node (18/20) CJS and
       bundlers that provide a `require`.
     - `loadExecutorStorageAsync()` adds a lazy `import('node:async_hooks')`
       for plain Node ESM < 22.3 (no getBuiltinModule, no free require); the
       daemon awaits it once at startup.
     - otherwise undefined — edge / browser / pure-Node-ESM apps without the
       async load. There is no in-flight task in those processes, so
       `currentExecutor()` correctly reads undefined (the app-side trigger path
       never needs the storage).
   ============================================================================= */
import type { AsyncLocalStorage as ALS } from 'node:async_hooks';

type StorageCtor = { new <T>(): ALS<T> };

/** `require` is a free variable in CJS builds and in bun's ESM; in pure Node
 *  ESM and edge it does not exist (typeof is then `'undefined'`, and the
 *  runtime throws only if we actually CALL it — which we don't). */
declare const require: ((id: string) => unknown) | undefined;

let cached: StorageCtor | undefined;
let tried = false;

/** The AsyncLocalStorage constructor, or undefined on platforms without it.
 *  Synchronous (getBuiltinModule / require); returns undefined where neither
 *  exists — plain Node ESM < 22.3 and edge/browser. */
export function getExecutorStorage(): StorageCtor | undefined {
  if (!tried) {
    tried = true;
    try {
      cached = load();
    } catch {
      // A require/getBuiltinModule that exists but refuses (sandboxed edge
      // runtime): run without ctx detection.
      cached = undefined;
    }
  }
  return cached;
}

/**
 * Like getExecutorStorage, but ALSO tries a lazy `import('node:async_hooks')`
 * when the synchronous paths came up empty — that is what makes a plain-Node
 * ESM daemon on Node < 22.3 work (it has neither getBuiltinModule nor a free
 * `require`). The daemon awaits this once at startup; edge/browser throw on
 * the import and get undefined (correct — no tasks run there).
 */
export async function loadExecutorStorageAsync(): Promise<StorageCtor | undefined> {
  const sync = getExecutorStorage();
  if (sync) return sync;
  try {
    const m = await import('node:async_hooks');
    return (m as { AsyncLocalStorage?: StorageCtor }).AsyncLocalStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function load(): StorageCtor | undefined {
  const g = globalThis as {
    process?: { getBuiltinModule?: (id: string) => unknown };
  };
  const builtin = g.process?.getBuiltinModule?.('node:async_hooks');
  if (builtin) {
    const ctor = (builtin as { AsyncLocalStorage?: StorageCtor }).AsyncLocalStorage;
    if (ctor) return ctor;
  }
  if (typeof require === 'function') {
    const ctor = (require('node:async_hooks') as { AsyncLocalStorage?: StorageCtor })
      .AsyncLocalStorage;
    if (ctor) return ctor;
  }
  return undefined;
}
