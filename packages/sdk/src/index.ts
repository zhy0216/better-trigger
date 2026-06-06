/* =============================================================================
   better-trigger — public entry point.
   ============================================================================= */

/* ---- core functions ----------------------------------------------------- */
export { task, unwrapResult } from './task';
export { configure } from './config';
export { startWorker } from './worker';

/* ---- re-exported error / signal primitives from core -------------------- */
export {
  AbortError,
  SuspendSignal,
  isAbortError,
  isSuspendSignal,
  serializeError,
} from '@better-trigger/core';

/* ---- client error helpers ----------------------------------------------- */
export { ApiError, isApiError, isRunNotRunning } from './client';

/* ---- value + type exports ----------------------------------------------- */
export type {
  TaskHandle,
  ConcurrencyConfig,
  CronInput,
  BatchItem,
  ResolvedTaskDefinition,
} from './task';
export type { SdkConfig } from './config';
export type { StartWorkerOptions, WorkerHandle } from './worker';
export type {
  RunCtx,
  RunInfo,
  RunLogger,
  RunWait,
  StepOptions,
} from './context';
export type { AnySchema, InferSchema } from './schema';

/* ---- re-exported domain types from core --------------------------------- */
export type {
  TaskRunResult,
  TriggerOptions,
  RetryPolicy,
  RunHandle,
  CronConfig,
  SerializedError,
  RunStatus,
  StepKind,
  StepStatus,
  TriggerType,
  LogLevel,
  TaskManifest,
} from '@better-trigger/core';
