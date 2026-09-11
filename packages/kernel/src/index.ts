/* =============================================================================
   @better-trigger/kernel — durable execution kernel over Postgres.
   Internal package: only apps/worker (and the acceptance harnesses) depend on
   it. The public SDK (`better-trigger`) never imports it — that is what keeps
   `pg` out of application processes.

   Only the names hosts actually import are exported; anything else lives in
   its module and can be re-exported when a host needs it.
   ============================================================================= */
export { createKernel } from './kernel';
export type { Kernel, KernelLogger } from './kernel';

export { fnSourceHash, stepFingerprint } from './fingerprint';

export { createOrchestratorCounters, nextCronAt } from './orchestrator';
export type { OrchestratorCounters, OrchestratorOptions } from './orchestrator';

export type { ClaimRunsArgs } from './queue';
export { MIN_RETENTION_MS } from './prune';
export { getRunDetail } from './runs';

/* Re-exported from @better-trigger/core so kernel consumers have a single
   import site: the error family crosses the wire (the SDK maps HTTP error
   envelopes back onto the same codes) and the read models ARE the JSON the
   worker returns. */
export {
  KernelError,
  RunNotRunningError,
  StaleLeaseError,
  TaskNotFoundError,
} from '@better-trigger/core';
export type { KernelErrorCode } from '@better-trigger/core';
