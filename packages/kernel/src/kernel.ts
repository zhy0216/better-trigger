/* =============================================================================
   @better-trigger/kernel — durable execution kernel.
   createKernel({ pool }) binds every engine operation to an injected pg Pool:
   client-side ops (trigger / cancel / retry / reads), worker-side ops (claim /
   heartbeat / step reporting under fencing) and the background orchestrator.
   The kernel owns no connection and starts no timers by itself — callers own
   the pool and start the orchestrator explicitly.
   ============================================================================= */
import type { Pool } from 'pg';
import type {
  ClaimedRun,
  CreatedRun,
  LogEntry,
  Namespace,
  RetryRunOptions,
  RunDetailResult,
  RunRecord,
  TriggerItem,
  WaitForResultOptions,
  WaitResult,
} from '@better-trigger/core';
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
  type FailResult,
  type FailRunArgs,
  type ReportStepArgs,
  type SuspendRunArgs,
  type TriggerArgs,
  type WaitForChildRunArgs,
} from './runs';
import {
  claimRuns,
  heartbeat,
  releaseClaims,
  type ClaimRunsArgs,
  type HeartbeatArgs,
  type HeartbeatResult,
  type ReleaseClaimsArgs,
  type ReleaseClaimsResult,
} from './queue';
import {
  deregisterWorker,
  registerWorker,
  type DeregisterWorkerArgs,
  type RegisterWorkerArgs,
} from './workers';
import { prune, type PruneArgs, type PruneResult } from './prune';

export interface KernelLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Wait-graph invariant counters (p1-37). The three conditions these observe
 * can never be true in a healthy engine, so any nonzero reading is the canary
 * for a lost parent wake:
 *
 *   - waitingWithoutPendingWait — PER-TICK GAUGE: runs the wait-due scanner's
 *     most recent pass found 'waiting' with no pending wait that could ever
 *     resolve them (a level, not a total — a persistent violation reads as
 *     the same number every tick; the scanner also logs the transition);
 *   - terminalChildPendingWait — PER-TICK GAUGE: pending 'run' waits the most
 *     recent pass found pointing at a child that already reached a terminal
 *     state, i.e. the child's terminal tx missed the wake (same gauge
 *     semantics as waitingWithoutPendingWait; logged on transition too);
 *   - cycleRejected — MONOTONIC counter: an attach-time cycle defense fired.
 *     Reserved for a real graph refusal (the defensive fresh-child-id
 *     collision); a bad idempotencyKey on triggerAndWait is a plain parameter
 *     error and does NOT count.
 *
 * Owned by createKernel and handed to the run paths and the orchestrator, so
 * hosts can export it the same way they export the orchestrator counters.
 */
export interface WaitGraphCounters {
  waitingWithoutPendingWait: number;
  terminalChildPendingWait: number;
  cycleRejected: number;
}

export function createWaitGraphCounters(): WaitGraphCounters {
  return { waitingWithoutPendingWait: 0, terminalChildPendingWait: 0, cycleRejected: 0 };
}

export interface KernelOptions {
  /** The pg Pool to run against. Owned by the caller. */
  pool: Pool;
  /** Sink for orchestrator loop errors. Defaults to console. */
  logger?: KernelLogger;
}

export interface Kernel {
  /* ------------------------------------------------------------- client */
  /**
   * Create one 'api' run (idempotencyKey honored). `args.namespace` is the
   * run's isolation scope — resolved by the host boundary, never defaulted
   * here (C2).
   */
  trigger(args: TriggerArgs): Promise<CreatedRun>;
  /**
   * Create N 'api' runs in one all-or-nothing transaction, all in the same
   * namespace.
   */
  batchTrigger(items: TriggerItem[], namespace: Namespace): Promise<{ runIds: string[] }>;
  /** Cancel a non-terminal run (terminal → no-op). Wakes a waiting parent. */
  cancelRun(runId: string, namespace: Namespace): Promise<void>;
  /**
   * Re-run a failed/canceled run as a NEW run (triggerType 'retry'). With
   * `opts.operationKey` the call is idempotent per (namespace, source run,
   * key) — a replayed request returns the FIRST call's new run id instead of
   * creating another (p2-38); without a key every call is a fresh retry.
   */
  retryRun(runId: string, namespace: Namespace, opts?: RetryRunOptions): Promise<{ runId: string }>;
  /** Full run record. */
  getRun(runId: string, namespace: Namespace): Promise<RunRecord>;
  /** Run + steps + waits + logs (logs capped at 1000). */
  getRunDetail(runId: string, namespace: Namespace): Promise<RunDetailResult>;
  /** Poll a run to a terminal state (timeout → latest non-terminal status). */
  waitForResult(
    runId: string,
    namespace: Namespace,
    opts?: WaitForResultOptions,
  ): Promise<WaitResult>;

  /* ------------------------------------------------------------- worker */
  /** Register a worker: workers row + per-namespace task upserts + schedule
   *  sync (one tx). `namespaces` is the set this worker claims from (C2). */
  registerWorker(args: RegisterWorkerArgs): Promise<{ workerId: string }>;
  /** Mark this worker offline on shutdown (ahead of the offline marker loop). */
  deregisterWorker(args: DeregisterWorkerArgs): Promise<void>;
  /** Renew leases for in-flight runs; returns runs canceled server-side and
   *  runs whose claim this worker has lost (reaped away, or gone terminal). */
  heartbeat(args: HeartbeatArgs): Promise<HeartbeatResult>;
  /** Hand this worker's undrained claims back to the queue on shutdown:
   *  claimable at once, attempt untouched (a handover, not a failure). */
  releaseClaims(args: ReleaseClaimsArgs): Promise<ReleaseClaimsResult>;
  /** Claim up to `limit` due runs (lease + fencing token per claim). Runs are
   *  filtered to the worker's namespaces (C2). */
  claimRuns(args: ClaimRunsArgs): Promise<ClaimedRun[]>;
  /** Record a memoized step row (fenced). */
  reportStep(args: ReportStepArgs): Promise<void>;
  /** Suspend on wait.for/wait.until; resumed:true if already due (fenced). */
  suspendRun(args: SuspendRunArgs): Promise<{ resumed: boolean }>;
  /**
   * triggerAndWait: create child + suspend parent until it finishes (fenced).
   * Global `options.idempotencyKey` is refused (bad_request) — the child's
   * identity is the parent's durable step `(run_id, step_seq)`, so a new
   * parent step always creates a new child (p1-37).
   */
  waitForChildRun(args: WaitForChildRunArgs): Promise<{ childRunId: string }>;
  /** Durable batchTrigger step: create children, record step row (fenced). */
  batchTriggerChild(args: BatchTriggerChildArgs): Promise<{ runIds: string[] }>;
  /** Terminal success (fenced). */
  completeRun(args: CompleteRunArgs): Promise<void>;
  /** Failure: retry with backoff or terminal fail + parent wakeup (fenced). */
  failRun(args: FailRunArgs): Promise<FailResult>;
  /** Best-effort log append, any non-terminal run status (no fencing); a run
   *  that is gone or already finished absorbs nothing and raises nothing. */
  appendLogs(runId: string, namespace: Namespace, entries: LogEntry[]): Promise<void>;

  /* ------------------------------------------------------ orchestration */
  /** Start the wait/cron/reaper/offline-marker loops (each individually
   *  switchable, all default on), plus the retention GC when
   *  `retentionMs` is set. Caller must stop(). All loops are scoped to
   *  `opts.namespaces` (absent ⇒ default namespace). */
  startOrchestrator(opts?: OrchestratorOptions): OrchestratorHandle;

  /* --------------------------------------------------------- retention */
  /** Delete terminal runs (steps + logs cascade) and offline worker rows older
   *  than `olderThanMs`, scoped to `args.namespaces` — a pruner never touches
   *  another namespace's history (C2). `dryRun: true` reports and deletes
   *  nothing. This is what `better-trigger-worker prune` and the GC loop both
   *  call. */
  prune(args: PruneArgs): Promise<PruneResult>;

  /* -------------------------------------------------------- observability */
  /** Wait-graph invariant counters (p1-37), live for the lifetime of this
   *  kernel. Read, never written, by whoever exports metrics — see
   *  WaitGraphCounters. */
  waitGraph: WaitGraphCounters;
}

export function createKernel(opts: KernelOptions): Kernel {
  const { pool } = opts;
  const logger: KernelLogger = opts.logger ?? console;
  const waitGraph = createWaitGraphCounters();

  return {
    trigger: (args) => trigger(pool, args),
    batchTrigger: (items, namespace) => batchTrigger(pool, items, namespace),
    cancelRun: (runId, namespace) => cancelRun(pool, runId, namespace),
    retryRun: (runId, namespace, opts) => retryRun(pool, runId, namespace, opts),
    getRun: (runId, namespace) => getRunRecord(pool, runId, namespace),
    getRunDetail: (runId, namespace) => getRunDetail(pool, runId, namespace),
    waitForResult: (runId, namespace, o) => waitForResult(pool, runId, namespace, o),

    registerWorker: (args) => registerWorker(pool, { ...args, logger: args.logger ?? logger }),
    deregisterWorker: (args) => deregisterWorker(pool, args),
    heartbeat: (args) => heartbeat(pool, args),
    releaseClaims: (args) => releaseClaims(pool, args),
    claimRuns: (args) => claimRuns(pool, { ...args, logger: args.logger ?? logger }),
    reportStep: (args) => reportStep(pool, args),
    suspendRun: (args) => suspendRun(pool, args),
    waitForChildRun: (args) => waitForChildRun(pool, args, waitGraph),
    batchTriggerChild: (args) => batchTriggerChild(pool, args),
    completeRun: (args) => completeRun(pool, args),
    failRun: (args) => failRun(pool, args),
    appendLogs: (runId, namespace, entries) => appendLogs(pool, runId, namespace, entries),

    startOrchestrator: (o) => startOrchestrator(pool, logger, o, waitGraph),
    prune: (args) => prune(pool, args),
    waitGraph,
  };
}
