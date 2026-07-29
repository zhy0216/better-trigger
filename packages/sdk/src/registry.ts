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
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RunExecutor } from './context';
import type { BetterTrigger, RunResultResolver } from './instance';

interface Registry {
  /** Holds the executor for the currently running task fn. */
  readonly executorStorage: AsyncLocalStorage<RunExecutor>;
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
  executorStorage: new AsyncLocalStorage<RunExecutor>(),
  defaultInstance: null,
  resultResolver: null,
});
