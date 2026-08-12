/* =============================================================================
   better-trigger/internal — the seam between defining tasks and running them.

   NOT a public API: no semver promise, no docs. It exists because the worker
   daemon (@better-trigger/worker) must reach into this package for two things
   it cannot get any other way:

     1. `executorStorage` — the AsyncLocalStorage a TaskHandle consults to
        decide "am I inside a run?". The worker and the user's task modules
        must share ONE copy of it, which means one copy of this module. (This
        is also why the worker keeps `better-trigger` external at build time.)
     2. the normalized task definition + its adapters, so the worker can turn
        the TaskHandles it imported into executable tasks and registration
        manifests.

   Anything an application should touch belongs in ./index instead.
   ============================================================================= */
export { executorStorage, currentExecutor } from './context';
export type { ExecutorTask, RunExecutor } from './context';

export { getExecutorStorage, loadExecutorStorageAsync } from './als';
export { setExecutorStorage } from './registry';

export { toExecutorTask, toManifest, normalizeCron } from './task';
export type { ResolvedTaskDefinition } from './task';

export { setResultResolver } from './instance';
export type { RunResultResolver } from './instance';
