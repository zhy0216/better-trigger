/* =============================================================================
   @better-trigger/worker — what the best-effort catches report through.

   runtime.ts and executor.ts swallow errors on purpose: a claim loop that dies
   on a DB hiccup, or an executor that crashes the process because a log flush
   failed, would be worse than the hiccup. Each catch is right on its own —
   together they let the daemon fail forever without printing a line. "Wrong
   password in DATABASE_URL" looks exactly like "nothing to do".

   So the catches stay, and gain a voice:
     - a throttled logger, so an outage costs one line per error kind per
       window instead of one per 300ms claim poll;
     - plain in-process counters, so "claim has failed 412 times in a row" is a
       number instead of a silence. These are the counters todos/03-operability.md
       O4 exports over /api/v1/metrics — defined here, once, so the metrics
       route reads them rather than declaring its own.
   ============================================================================= */
import type { KernelLogger } from '@better-trigger/kernel';

/** The daemon's log sink. Structurally `console`; the kernel's own logger fits
 *  too, so a host that already has one passes the same object everywhere. */
export type WorkerLogger = KernelLogger;

/** Default quiet window: at most one line per error kind per 30s. */
export const DEFAULT_LOG_THROTTLE_MS = 30_000;

export interface ThrottledLogger {
  /**
   * Report `err` once per `key` per window. Repeats inside the window are
   * counted, not printed, and the count rides along on the next line that gets
   * through — so a five-minute outage reads as a handful of lines that say how
   * many times it actually happened.
   */
  warn(key: string, message: string, err: unknown): void;
}

export function createThrottledLogger(
  logger: WorkerLogger,
  intervalMs: number = DEFAULT_LOG_THROTTLE_MS,
): ThrottledLogger {
  // Keyed by loop + error kind, so the map is bounded by the code's own shape
  // (a handful of call sites × a handful of pg/kernel error codes).
  const seen = new Map<string, { last: number; suppressed: number }>();
  return {
    warn(key, message, err) {
      const now = Date.now();
      const state = seen.get(key);
      if (state && now - state.last < intervalMs) {
        state.suppressed += 1;
        return;
      }
      const suppressed = state?.suppressed ?? 0;
      seen.set(key, { last: now, suppressed: 0 });
      const folded =
        suppressed > 0
          ? ` (+${suppressed} more in the last ${Math.round(intervalMs / 1000)}s)`
          : '';
      logger.warn(`[better-trigger] ${message}${folded}`, describeError(err));
    },
  };
}

/**
 * The throttle bucket an error belongs to. A pg error code (`28P01` = bad
 * password, `ECONNREFUSED` = no server) is the stable half of "same kind of
 * failure"; the message is not, since it often carries the row or host that
 * varies per attempt.
 */
export function errorKey(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    return err.name;
  }
  return typeof err;
}

/** Stack when there is one — this line may be the only record of the fault. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Per-runtime failure counters. Monotonic totals plus the two "in a row"
 * gauges, which are the ones that separate "a DB blip at 3am" from "this
 * worker has not been able to reach Postgres since it booted".
 *
 * Plain numbers on a plain object: the runtime hands the same instance to the
 * daemon (WorkerHandle.counters), so O4's metrics route reads live values with
 * no registry and no wiring of its own.
 */
export interface WorkerCounters {
  /** Execution passes this process finished, by Executor result type. NOT run
   *  status: 'failed' here is an attempt the executor reported as failed, which
   *  the kernel may still schedule another attempt for. Kept as a literal union
   *  rather than an import of ExecutionResult so this module stays free of
   *  executor.ts (which imports it); the runtime's write site is what the
   *  compiler checks the two against. */
  runOutcomes: Record<'completed' | 'failed' | 'suspended' | 'abandoned', number>;
  /** kernel.claimRuns() rejections, all slots. */
  claimErrors: number;
  /** Claim rejections since the last claim that came back — resets on success. */
  consecutiveClaimErrors: number;
  /** kernel.heartbeat() rejections (each one is leases drifting towards reap). */
  heartbeatErrors: number;
  /** Heartbeat rejections since the last one that landed. */
  consecutiveHeartbeatErrors: number;
  /** Executor.execute() throws the claim loop had to absorb. */
  executorErrors: number;
  /** Failed-step rows the executor could not write (the run still fails, but
   *  without the step that explains why). */
  stepReportErrors: number;
  /** Failures the executor could not report (the run stays running until reaped). */
  failReportErrors: number;
  /** Log flushes that were dropped. */
  logFlushErrors: number;
}

export function createWorkerCounters(): WorkerCounters {
  return {
    runOutcomes: { completed: 0, failed: 0, suspended: 0, abandoned: 0 },
    claimErrors: 0,
    consecutiveClaimErrors: 0,
    heartbeatErrors: 0,
    consecutiveHeartbeatErrors: 0,
    executorErrors: 0,
    stepReportErrors: 0,
    failReportErrors: 0,
    logFlushErrors: 0,
  };
}

/**
 * Counters for the notification fast-path (PF2, todos/02-performance.md):
 * how much the LISTEN connection delivers, how often it had to re-establish
 * itself, and how many result waiters / claim sleeps it settled instead of a
 * poll. Plain monotonic totals on a plain object, like WorkerCounters — the
 * metrics route reads them live, no registry.
 */
export interface NotifyCounters {
  /** pg_notify messages received on the bt channel (any payload). */
  notificationsReceived: number;
  /** Times the LISTEN connection dropped and had to re-establish itself. */
  listenReconnects: number;
  /** Result waiters settled by the in-process registry (terminal, or the run
   *  vanished). */
  waiterResolutions: number;
  /** Result waiters that hit their deadline (latest non-terminal status). */
  waiterTimeouts: number;
  /** Work notifications that woke the idle claim loops. */
  claimWakes: number;
}

export function createNotifyCounters(): NotifyCounters {
  return {
    notificationsReceived: 0,
    listenReconnects: 0,
    waiterResolutions: 0,
    waiterTimeouts: 0,
    claimWakes: 0,
  };
}

/**
 * The line a fatal fault leaves behind (main.ts's crash handlers). Which worker
 * died, and what it was executing when it did: those run ids are the runs that
 * stay 'running' until the lease reaper picks them up, and once the process is
 * gone this log is the only place they are named. Rendered here, not inline at
 * the call site, so the "with in-flight ids" shape is testable without spawning
 * a daemon that happens to be busy.
 */
export function formatCrashContext(
  kind: string,
  workerId: string | null | undefined,
  runIds: readonly string[],
): string {
  return (
    `[better-trigger] fatal ${kind}: exiting. ` +
    `worker=${workerId ?? 'none'} ` +
    `in-flight=${runIds.length > 0 ? runIds.join(',') : 'none'}`
  );
}

/** What the runtime hands an Executor so its own best-effort catches (failure
 *  reporting, log shipping) are not silent either. */
export interface ExecutorDiagnostics {
  log: ThrottledLogger;
  counters: WorkerCounters;
}
