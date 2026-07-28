/* =============================================================================
   @better-trigger/core — durable execution kernel.
   createKernel({ pool }) binds every engine operation to an injected pg Pool:
   client-side ops (trigger / cancel / retry / reads), worker-side ops (claim /
   heartbeat / step reporting under fencing) and the background orchestrator.
   The kernel owns no connection and starts no timers by itself — callers own
   the pool and start the orchestrator explicitly.
   ============================================================================= */
import type { Pool } from 'pg';
import type { ClaimedRun, LogEntry, TriggerItem } from '../types';
import {
  startOrchestrator,
  type OrchestratorHandle,
  type OrchestratorOptions,
} from './orchestrator';
import {
  appendLogs,
  batchTrigger,
  batchTriggerChild,
  cancelRun,
  completeRun,
  failRun,
  getRunDetail,
  getRunRecord,
  reportStep,
  retryRun,
  suspendRun,
  trigger,
  waitForChildRun,
  waitForResult,
  type BatchTriggerChildArgs,
  type CompleteRunArgs,
  type CreatedRun,
  type FailResult,
  type FailRunArgs,
  type ReportStepArgs,
  type RunDetailResult,
  type RunRecord,
  type SuspendRunArgs,
  type TriggerArgs,
  type WaitForChildRunArgs,
  type WaitForResultOptions,
  type WaitResult,
} from './runs';
import { claimRuns, heartbeat, type ClaimRunsArgs, type HeartbeatArgs } from './queue';
import { registerWorker, type RegisterWorkerArgs } from './workers';

export interface KernelLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface KernelOptions {
  /** The pg Pool to run against. Owned by the caller. */
  pool: Pool;
  /** Sink for orchestrator loop errors. Defaults to console. */
  logger?: KernelLogger;
}

export interface Kernel {
  /* ------------------------------------------------------------- client */
  /** Create one 'api' run (idempotencyKey honored). */
  trigger(args: TriggerArgs): Promise<CreatedRun>;
  /** Create N 'api' runs in one all-or-nothing transaction. */
  batchTrigger(items: TriggerItem[]): Promise<{ runIds: string[] }>;
  /** Cancel a non-terminal run (terminal → no-op). Wakes a waiting parent. */
  cancelRun(runId: string): Promise<void>;
  /** Re-run a failed/canceled run as a NEW run (triggerType 'retry'). */
  retryRun(runId: string): Promise<{ runId: string }>;
  /** Full run record. */
  getRun(runId: string): Promise<RunRecord>;
  /** Run + steps + waits + logs (logs capped at 1000). */
  getRunDetail(runId: string): Promise<RunDetailResult>;
  /** Poll a run to a terminal state (timeout → latest non-terminal status). */
  waitForResult(runId: string, opts?: WaitForResultOptions): Promise<WaitResult>;

  /* ------------------------------------------------------------- worker */
  /** Register a worker: workers row + task upserts + schedule sync (one tx). */
  registerWorker(args: RegisterWorkerArgs): Promise<{ workerId: string }>;
  /** Renew leases for in-flight runs; returns runs canceled server-side. */
  heartbeat(args: HeartbeatArgs): Promise<{ cancelRunIds: string[] }>;
  /** Claim up to `limit` due runs (lease + fencing token per claim). */
  claimRuns(args: ClaimRunsArgs): Promise<ClaimedRun[]>;
  /** Record a memoized step row (fenced). */
  reportStep(args: ReportStepArgs): Promise<void>;
  /** Suspend on wait.for/wait.until; resumed:true if already due (fenced). */
  suspendRun(args: SuspendRunArgs): Promise<{ resumed: boolean }>;
  /** triggerAndWait: create child + suspend parent until it finishes (fenced). */
  waitForChildRun(args: WaitForChildRunArgs): Promise<{ childRunId: string }>;
  /** Durable batchTrigger step: create children, record step row (fenced). */
  batchTriggerChild(args: BatchTriggerChildArgs): Promise<{ runIds: string[] }>;
  /** Terminal success (fenced). */
  completeRun(args: CompleteRunArgs): Promise<void>;
  /** Failure: retry with backoff or terminal fail + parent wakeup (fenced). */
  failRun(args: FailRunArgs): Promise<FailResult>;
  /** Best-effort log append, any run status (no fencing). */
  appendLogs(runId: string, entries: LogEntry[]): Promise<void>;

  /* ------------------------------------------------------ orchestration */
  /** Start the wait/cron/reaper/offline-marker loops (each individually
   *  switchable, all default on). Caller must stop(). */
  startOrchestrator(opts?: OrchestratorOptions): OrchestratorHandle;
}

export function createKernel(opts: KernelOptions): Kernel {
  const { pool } = opts;
  const logger: KernelLogger = opts.logger ?? console;

  return {
    trigger: (args) => trigger(pool, args),
    batchTrigger: (items) => batchTrigger(pool, items),
    cancelRun: (runId) => cancelRun(pool, runId),
    retryRun: (runId) => retryRun(pool, runId),
    getRun: (runId) => getRunRecord(pool, runId),
    getRunDetail: (runId) => getRunDetail(pool, runId),
    waitForResult: (runId, o) => waitForResult(pool, runId, o),

    registerWorker: (args) => registerWorker(pool, args),
    heartbeat: (args) => heartbeat(pool, args),
    claimRuns: (args) => claimRuns(pool, args),
    reportStep: (args) => reportStep(pool, args),
    suspendRun: (args) => suspendRun(pool, args),
    waitForChildRun: (args) => waitForChildRun(pool, args),
    batchTriggerChild: (args) => batchTriggerChild(pool, args),
    completeRun: (args) => completeRun(pool, args),
    failRun: (args) => failRun(pool, args),
    appendLogs: (runId, entries) => appendLogs(pool, runId, entries),

    startOrchestrator: (o) => startOrchestrator(pool, logger, o),
  };
}
