/* =============================================================================
   better-trigger — public entry point.
   ============================================================================= */

/* ---- core functions ----------------------------------------------------- */
export { task, unwrapResult } from './task';
export { betterTrigger } from './instance';

/* ---- re-exported error / signal primitives from core -------------------- */
export {
  AbortError,
  SuspendSignal,
  isAbortError,
  isSuspendSignal,
  serializeError,
} from '@better-trigger/core';

/* ---- value + type exports ----------------------------------------------- */
export type {
  TaskHandle,
  ConcurrencyConfig,
  CronInput,
  BatchItem,
  ResolvedTaskDefinition,
} from './task';
export type { BetterTrigger, BetterTriggerOptions, RunHandle } from './instance';
export type { WorkerHandle } from './worker';
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
  TriggerItem,
  RetryPolicy,
  CronConfig,
  SerializedError,
  RunStatus,
  StepKind,
  StepStatus,
  TriggerType,
  LogLevel,
  TaskManifest,
  RunRecord,
  RunDetailResult,
  WaitResult,
  WaitForResultOptions,
} from '@better-trigger/core';
