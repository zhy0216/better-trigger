/* =============================================================================
   @better-trigger/core — kernel public surface.
   ============================================================================= */
export { createKernel } from './kernel';
export type { Kernel, KernelLogger, KernelOptions } from './kernel';

export {
  KernelError,
  RunNotRunningError,
  StaleLeaseError,
  TaskNotFoundError,
} from './errors';
export type { KernelErrorCode } from './errors';

export { nextCronAt } from './orchestrator';
export type { OrchestratorHandle, OrchestratorOptions } from './orchestrator';

export type { ClaimRunsArgs, HeartbeatArgs } from './queue';
export type { RegisterWorkerArgs } from './workers';
export type {
  BatchTriggerChildArgs,
  CompleteRunArgs,
  CreatedRun,
  CreateRunArgs,
  FailResult,
  FailRunArgs,
  LogRecord,
  ReportStepArgs,
  RunDetailResult,
  RunRecord,
  RunStepRecord,
  SuspendRunArgs,
  TriggerArgs,
  WaitForChildRunArgs,
  WaitForResultOptions,
  WaitRecord,
  WaitResult,
} from './runs';
