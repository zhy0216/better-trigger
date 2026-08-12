/* =============================================================================
   better-trigger — process-wide registry.

   Three pieces of state have to be shared between "code that defines tasks"
   and "code that runs them": the AsyncLocalStorage carrying the active
   executor, the default client, and the resolver RunHandle.result() reads
   from. The worker daemon sets them; user task modules read them.

   They hang off a Symbol.for() slot on globalThis rather than off module
   scope, so a duplicated copy of this package (two node_modules trees, a
   bundled build next to a linked one) still shares ONE registry. Otherwise
   `ctx`-detection would silently fail: triggerAndWait() inside a run would not
   see the executor and would throw "must be called inside a running task".
   ============================================================================= */
import type { AsyncLocalStorage } from 'node:async_hooks';
import { getExecutorStorage } from './als';
import type { RunExecutor } from './context';
import type { BetterTrigger, RunResultResolver } from './instance';

interface Registry {
  /** Holds the executor for the currently running task fn. Lazy (p1-16):
   *  undefined on platforms without node:async_hooks — there is no in-flight
   *  task there, so ctx-detection correctly reads nothing. Populated late via
   *  setExecutorStorage when a daemon resolves it asynchronously (Node ESM
   *  < 22.3). */
  executorStorage: AsyncLocalStorage<RunExecutor> | undefined;
  /** First betterTrigger() instance, or the last one to call setDefault(). */
  defaultInstance: BetterTrigger | null;
  /** Overrides where RunHandle.result() reads from (installed by the daemon). */
  resultResolver: RunResultResolver | null;
}

/** Versioned so an incompatible future shape cannot silently adopt this one. */
const KEY = Symbol.for('better-trigger.registry.v1');

type GlobalWithRegistry = typeof globalThis & { [KEY]?: Registry };

const g = globalThis as GlobalWithRegistry;

export const registry: Registry = (g[KEY] ??= {
  // Lazy (p1-16): the AsyncLocalStorage CONSTRUCTOR is fetched synchronously
  // here (getBuiltinModule / require). Undefined on edge/browser — there is
  // no in-flight task in those processes. A daemon whose runtime lacks the
  // synchronous path (plain Node ESM < 22.3) resolves it asynchronously at
  // startup and calls setExecutorStorage.
  executorStorage: (() => {
    const Ctor = getExecutorStorage();
    return Ctor ? new Ctor<RunExecutor>() : undefined;
  })(),
  defaultInstance: null,
  resultResolver: null,
});

/** Populate the shared executor storage late (p1-16): used by the daemon after
 *  an asynchronous node:async_hooks load on runtimes without the sync path. */
export function setExecutorStorage(storage: AsyncLocalStorage<RunExecutor> | undefined): void {
  registry.executorStorage = storage;
}
