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

/* ---- run-abort signalling (ctx.signal) ---------------------------------- */
export { RunAbortedError, isRunAborted } from './context';

/* ---- re-exported error / signal primitives from core -------------------- */
export {
  AbortError,
  KernelError,
  NonDeterminismError,
  SuspendSignal,
  isAbortError,
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
  ResolvedTaskDefinition,
} from './task';
export type { BetterTrigger, BetterTriggerOptions, RunHandle } from './instance';
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
