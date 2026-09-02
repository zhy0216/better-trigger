/* =============================================================================
   better-trigger — public entry point.

   Two things live here: how you DEFINE tasks (`task()`) and how you TRIGGER
   them (`betterTrigger({ url })`, over HTTP). Running them is the worker
   daemon's job — see @better-trigger/worker / `better-trigger-worker`.
   ============================================================================= */

/* ---- core functions ----------------------------------------------------- */
export { task, unwrapResult } from './task';
export { betterTrigger } from './instance';

/* ---- transport ---------------------------------------------------------- */
export { HttpError } from './client';

/* ---- waitForResult timeout (p2-23) -------------------------------------- */
export { ResultTimeoutError } from './instance';

/* ---- run-abort signalling (ctx.signal) ---------------------------------- */
export { RunAbortedError, isRunAborted } from './context';

/* ---- re-exported error / signal primitives from core -------------------- */
export {
  AbortError,
  KernelError,
  NonDeterminismError,
  SuspendSignal,
  isAbortError,
  isExecutionEndedSignal,
  isNonDeterminismError,
  isSuspendSignal,
  isControlFlowSignal,
  serializeError,
} from '@better-trigger/core';

/* ---- value + type exports ----------------------------------------------- */
export type {
  TaskHandle,
  ConcurrencyConfig,
  CronInput,
  BatchItem,
  BatchItemOptions,
  ResolvedTaskDefinition,
} from './task';
export type {
  BetterTrigger,
  BetterTriggerOptions,
  BatchTriggerItem,
  RunHandle,
} from './instance';
export type {
  RunCtx,
  RunInfo,
  RunLogger,
  RunWait,
  RunAbortReason,
  StepOptions,
} from './context';
export type { AnySchema, InferSchema } from './schema';

/* ---- re-exported domain types from core --------------------------------- */
export type {
  ExecutionEndedSignal,
  Namespace,
  RetryRunOptions,
  TaskRunResult,
  TriggerOptions,
  TriggerItem,
  RetryPolicy,
  CronConfig,
  SerializedError,
  KernelErrorCode,
  RunStatus,
  StepKind,
  StepStatus,
  TriggerType,
  LogLevel,
  TaskManifest,
  CreatedRun,
  RunRecord,
  RunStepRecord,
  RunDetailResult,
  WaitRecord,
  LogRecord,
  WaitResult,
  WaitForResultOptions,
} from '@better-trigger/core';
