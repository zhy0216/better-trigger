/* =============================================================================
   @better-trigger/worker — library surface.
   Exports the app factory, the execution runtime, the task loader, db handles
   and the REST types, so the daemon can be embedded or driven from tests.
   The runnable process entry is src/main.ts (bin: better-trigger-worker).
   ============================================================================= */
export { createApp, type AppDeps } from './app';
export { type MetricsSources } from './routes/metrics';
export { loadTasks, type LoadedTasks } from './loader';
export {
  startWorkerRuntime,
  resolveCodeVersion,
  type StartOptions,
  type WorkerDeps,
  type WorkerHandle,
} from './runtime';
export { Executor, type ExecutionResult } from './executor';
export {
  DEFAULT_LOG_THROTTLE_MS,
  type WorkerCounters,
  type WorkerLogger,
} from './observability';
export { createHealthPool, createPool, DEFAULT_DATABASE_URL, migrate, schema } from '@better-trigger/db';
export * from './types';
