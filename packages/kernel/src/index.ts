/* =============================================================================
   @better-trigger/kernel — durable execution kernel over Postgres.
   Internal package: only apps/worker (and the acceptance harnesses) depend on
   it. The public SDK (`better-trigger`) never imports it — that is what keeps
   `pg` out of application processes.
   ============================================================================= */
export { createKernel } from './kernel';
export type { Kernel, KernelLogger, KernelOptions, WaitGraphCounters } from './kernel';

export { fnSourceHash, stepFingerprint } from './fingerprint';
export type { StepFingerprintArgs } from './fingerprint';

export { createOrchestratorCounters, nextCronAt } from './orchestrator';
export type {
  OrchestratorCounters,
  OrchestratorHandle,
  OrchestratorOptions,
} from './orchestrator';

export type {
  ClaimRunsArgs,
  HeartbeatArgs,
  HeartbeatResult,
  ReleaseClaimsArgs,
  ReleaseClaimsResult,
  StrandedGroup,
  StrandedScan,
} from './queue';
export type { DeregisterWorkerArgs, RegisterWorkerArgs } from './workers';
export { MIN_RETENTION_MS, PRUNE_BATCH } from './prune';
export type { PruneArgs, PruneResult } from './prune';
export { getRunDetail } from './runs';
export type { RunDetailOptions } from './runs';
export type {
  BatchTriggerChildArgs,
  CompleteRunArgs,
  CreateRunArgs,
  FailResult,
  FailRunArgs,
  ReportStepArgs,
  SuspendRunArgs,
  TriggerArgs,
  WaitForChildRunArgs,
} from './runs';

/* Re-exported from @better-trigger/core so kernel consumers have a single
   import site. Both live there because both cross the wire: the error family
   is transport neutral (the SDK maps HTTP error envelopes back onto the same
   codes) and the read models ARE the JSON the worker returns. */
export {
  KernelError,
  NonDeterminismError,
  RunNotRunningError,
  StaleLeaseError,
  TaskNotFoundError,
  isNonDeterminismError,
} from '@better-trigger/core';
export { DEFAULT_NAMESPACE } from '@better-trigger/core';
export type {
  CreatedRun,
  KernelErrorCode,
  LogRecord,
  Namespace,
  RunDetailResult,
  RunRecord,
  RunStepRecord,
  WaitForResultOptions,
  WaitRecord,
  WaitResult,
} from '@better-trigger/core';
