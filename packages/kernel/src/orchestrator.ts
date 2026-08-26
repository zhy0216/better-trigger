/* =============================================================================
   @better-trigger/kernel — kernel background orchestrator.
   Four interval loops (each with re-entrancy guards, each individually
   switchable via OrchestratorOptions — all default on), plus a fifth that is
   default OFF (5. retention GC, below):
     1. wait-due scanner   (timerIntervalMs, 1s)   — resume duration/until waits
     2. cron scheduler     (cronIntervalMs, 1s)    — fire due schedules via
        createRunIn (task retry policy resolved like any other trigger)
     3. lease reaper       (reaperIntervalMs, 10s) — recover runs whose
        lease_until has expired (spends runs.recoveries, never runs.attempt —
        losing a worker is infrastructure, not the user's code failing)
     4. worker offline marker (30s)                — mark workers with no
        heartbeat > 2m
     5. retention GC       (gcIntervalMs, 1h)      — delete terminal runs (and
        their cascaded steps/logs) and offline worker rows older than
        `retentionMs`. Runs ONLY when `retentionMs` is set: the default daemon
        deletes no history at all (todos/02-performance.md PF6).
   A bookkeeping-only host (e.g. the dashboard server) runs { waits: false,
   cron: false } so it reaps leases and marks workers offline without becoming
   an execution scheduler. All loops follow the canonical kernel lock order
   (queue → runs → dependent rows; see runs.ts header), and neither scan ever
   queues up behind the peer that is already processing a row: every daemon
   re-derives the same candidates every tick, so blocking would only buy the
   right to discover the work is done. Each therefore takes SKIP LOCKED at the
   position where peers actually collide, and leaves what it cannot get to the
   next tick — the wait scanner at positions 2 and 3 (tryLockRunRow, then the
   wait row), the reaper at position 1 (its expired-lease queue scan).
   Their *other* positions are plain blocking FOR UPDATE, deliberately, and
   still cannot end up waiting on a peer:
     - wait scanner, position 1 — a suspended run has no queue row (suspendRun
       deleted it), so it is a 0-row no-op on this path; it is taken at all to
       stop the closing INSERT ... ON CONFLICT on queue from inverting 2→1.
     - reaper, position 2 (lockRunRow) — by then it already holds that run's
       queue row, and since every kernel path takes queue before runs, no peer
       can be holding the runs row it is asking for.
   runs.ts spells out the scanner case ("Position 1 stays blocking on purpose")
   and the disjoint candidate sets the reaper's queue scan relies on.
   See docs/backend-contract.md §3.2, §3.5, §3.6. Loop errors are swallowed
   (logged via the kernel logger) so loops never die.
   ============================================================================= */
import { Cron } from 'croner';
import type { Pool } from 'pg';
import {
  DEFAULT_NAMESPACE,
  KernelError,
  assertNamespace,
  type Namespace,
} from '@better-trigger/core';
import type { KernelLogger, WaitGraphCounters } from './kernel';
import { prune } from './prune';
import {
  enqueue,
  nsPredicateFor,
  scanStrandedRuns,
  type StrandedScan,
} from './queue';
import {
  createRunIn,
  lockRunRow,
  terminalFail,
  tryLockRunRow,
  upsertStep,
  withTx,
} from './runs';
import { notifyTerminal, notifyWork } from './notify';

const WORKER_OFFLINE_MS = 120_000;
const WORKER_OFFLINE_SCAN_MS = 30_000;

/**
 * How often the stranded-run scan looks, when pinning switches it on. Slow on
 * purpose: it reports a condition that only a deploy (or a worker coming back)
 * can change, and it is the one loop whose query walks the unclaimed queue
 * without a lease to bound it.
 */
const STRANDED_SCAN_MS = 30_000;

/** Stable text of a scan, so the loop can log transitions instead of ticks. */
function signatureOf(scan: StrandedScan): string {
  return scan.groups
    .map((g) => `${g.taskId}@${g.codeVersion}=${g.count}`)
    .join(',')
    .concat(scan.truncated ? '+' : '');
}

/**
 * How often the retention GC looks, when it is switched on at all
 * (todos/02-performance.md PF6). Deliberately the slowest loop in the file by
 * three orders of magnitude: it deletes history, so it is a housekeeping job,
 * not a scheduler — and every daemon on the database runs it, so a short
 * interval would only mean N processes racing to find the same nothing.
 */
const GC_INTERVAL_MS = 3_600_000;

/**
 * How many expired leases one reap tick takes (todos/02-performance.md PF1);
 * scanWaits/scanCron cap their batches at 50 for the same reason.
 *
 * Without a cap, a fleet-wide crash (a batch of daemons dying together) makes
 * one transaction lock every expired queue row at once and walk them one by
 * one, and for that whole transaction the claim path's SKIP LOCKED bounces off
 * all of them — a recovery storm that stalls execution instead of restoring it.
 * The bound turns it into 100 rows per 10s tick, which cannot starve: the scan
 * takes the OLDEST leases first (ORDER BY lease_until ASC) and every row it
 * processes leaves the candidate set (lease_until := NULL on requeue, the queue
 * row deleted on terminal fail), so the remainder is strictly closer to the
 * head on the next tick. Rows another daemon holds are skipped, not lost —
 * whoever holds them is reaping them.
 */
const REAP_BATCH = 100;

/** Compute the next fire time for a cron pattern, in a timezone. */
export function nextCronAt(pattern: string, timezone?: string, from?: Date): Date | null {
  const cron = new Cron(pattern, timezone ? { timezone } : {});
  return cron.nextRun(from ?? new Date());
}

export interface OrchestratorOptions {
  /** Wait-due scan interval (default 1s). */
  timerIntervalMs?: number;
  /** Cron scan interval (default 1s). */
  cronIntervalMs?: number;
  /** Expired-lease reap interval (default 10s). */
  reaperIntervalMs?: number;
  /** Run the wait-due scanner loop (default true). */
  waits?: boolean;
  /** Run the cron scheduler loop (default true). */
  cron?: boolean;
  /** Run the lease reaper loop (default true). */
  reaper?: boolean;
  /** Run the worker offline marker loop (default true). */
  workerOffline?: boolean;
  /**
   * Retention window in ms for the data-retention GC loop
   * (todos/02-performance.md PF6). **Off unless set**, and there is no default
   * window on purpose: the loop deletes finished runs, their steps and their
   * logs, and a runtime that starts quietly throwing history away because
   * nobody passed a flag is a data-loss bug, not a feature. `--retention 30d`
   * on the daemon is what turns it on.
   *
   * Must be at least MIN_RETENTION_MS; anything smaller is rejected by
   * prune() (the loop logs it once per tick rather than dying).
   */
  retentionMs?: number;
  /** Retention GC interval (default 1h). Only used when retentionMs is set. */
  gcIntervalMs?: number;
  /**
   * Run the stranded-run scan (default false). Turn it on where version pinning
   * is on — `--pin-code-version` does — and leave it off everywhere else: with
   * no pinning, every run it would report is one the next unpinned poll claims,
   * so the loop would only manufacture false alarms.
   */
  stranded?: boolean;
  /** Stranded-run scan interval (default 30s). Only used when `stranded`. */
  strandedIntervalMs?: number;
  /**
   * Namespaces this daemon serves. Every loop (wait scan, cron scan, reaper,
   * stranded scan, retention GC) filters its SQL on these pairs — a daemon
   * configured for staging never resumes prod waits or fires prod crons (C2).
   * Absent ⇒ [DEFAULT_NAMESPACE] ('default'/'prod'), resolved once here, at
   * this boundary.
   */
  namespaces?: readonly Namespace[];
}

/**
 * Live loop counters for whoever exports metrics (apps/worker's /metrics route,
 * todos/03-operability.md O4). Monotonic totals on a plain object, handed out
 * on the handle: the kernel keeps no registry and the reader keeps no copy, so
 * "how many runs did the reaper recover this hour" is a subtraction of two
 * scrapes rather than a query.
 */
export interface OrchestratorCounters {
  /** Expired-lease claims handed back to the queue: the run resumes on its
   *  SAME attempt and spends one of its `recoveries` instead. */
  reaperRequeued: number;
  /** Expired-lease claims out of *recoveries* (not attempts) → terminal
   *  'worker lost'. */
  reaperFailed: number;
  /** Runs deleted by the retention GC loop, all time on this handle. Stays 0
   *  on the default configuration, where the loop does not run at all. */
  gcRunsDeleted: number;
  /** Offline worker rows deleted by the retention GC loop. */
  gcWorkersDeleted: number;
  /**
   * Version-pinned runs no online worker can claim, as of the last stranded
   * scan. The one *gauge* in here on purpose: "how many runs are stuck right
   * now" is a level, not a total, and a monotonic counter could never fall back
   * to zero when the missing worker returns. Empty unless the stranded loop
   * runs at all (`stranded`), which is to say unless something pins.
   */
  stranded: StrandedScan;
  /** Loop iterations that threw, per loop. Each one is logged too, but a rate
   *  is what says "the cron loop has been failing all afternoon". */
  loopErrors: {
    waits: number;
    cron: number;
    reaper: number;
    workers: number;
    gc: number;
    stranded: number;
  };
  /** Epoch ms of the last tick that completed without throwing, per loop. A
   *  loop whose last success stops advancing is stalled — the re-entrancy
   *  guard would otherwise swallow the stall with loopErrors still 0. */
  loopLastSuccess: {
    waits: number;
    cron: number;
    reaper: number;
    workers: number;
    gc: number;
    stranded: number;
  };
}

export function createOrchestratorCounters(): OrchestratorCounters {
  return {
    reaperRequeued: 0,
    reaperFailed: 0,
    gcRunsDeleted: 0,
    gcWorkersDeleted: 0,
    stranded: { groups: [], truncated: false },
    loopErrors: { waits: 0, cron: 0, reaper: 0, workers: 0, gc: 0, stranded: 0 },
    // 0 = "this loop has never ticked" — the metrics reader emits only loops
    // that have actually run, so a deliberately-disabled loop (e.g. waits on
    // an API-only daemon) does not read as a stalled one.
    loopLastSuccess: { waits: 0, cron: 0, reaper: 0, workers: 0, gc: 0, stranded: 0 },
  };
}

export interface OrchestratorHandle {
  stop(): void;
  /** Loop counters, live for the lifetime of this handle. Read, never written,
   *  by whoever exports metrics. */
  counters: OrchestratorCounters;
}

/* ------------------------------------------------------- waits: phase 1 scans */
// Phase 1 — discover due work with a plain read, holding no locks. Two
// candidate classes:
//   - due timer waits (kind 'duration'/'until', resume_at passed) — the
//     regular resume path;
//   - orphan run-waits (kind 'run' with child_run_id NULL, C5): the child
//     run was deleted out from under the wait — waits.child_run_id is
//     ON DELETE SET NULL, so a pending run-wait whose child id vanished is
//     exactly this. The child can never deliver a result, so the parent
//     must be failed, never resumed (phase 2 branches on kind).
// fingerprint rides along: the executor computed it from the DECLARED wait
// (duration string / until instant) when it suspended, and the resume must
// stamp the completed step row with that same value (C1). project_id/env
// ride along so every statement below re-scopes on the wait's namespace
// (C2) — a staging daemon never resumes prod waits.
//
// The scan is split into TWO queries with independent LIMITs so the two
// classes can never crowd each other out of the window. Postgres sorts
// ASC NULLS LAST, so a single query ordering by resume_at would push every
// orphan run-wait (resume_at IS NULL) behind all due timer waits; once 50
// timer waits are due per tick, orphans would never enter the LIMIT window
// and C5 recovery would starve. Each scan gets its own LIMIT instead: the
// timer scan keeps the resume_at order, the orphan scan orders by id (it
// has no resume_at to order by). Phase 2 below iterates the combined rows.
//
// Both candidate queries run PER NAMESPACE (todos/02-performance.md
// p1-08): one scan per namespace with its own fresh params array (each
// predicate renumbers $1..$2), and the rows are concatenated before phase
// 2. A single VALUES-based query over all namespaces becomes a semi-join
// whose (project_id, env) pairs lose their equality constraints on the
// index prefix, so ≥2 namespaces degrade the scan to sorting the whole
// backlog; per-namespace equalities bind the index directly. With one
// namespace the SQL is identical to the pre-split form.
type WaitRow = {
  id: number;
  run_id: string;
  project_id: string;
  env: string;
  step_seq: number;
  fingerprint: string | null;
  kind: string;
  child_run_id: string | null;
};

async function scanDueWaits(
  pool: Pool,
  namespaces: readonly Namespace[],
): Promise<WaitRow[]> {
  // Both candidate queries run PER NAMESPACE and their rows interleave per
  // namespace (timer, then orphan, then the next namespace) — exactly the
  // order the pre-split scanWaits produced, so phase 2 resumes in the same
  // sequence. Two queries with independent LIMITs so the two classes can
  // never crowd each other out of the window (see the p1-37 comment).
  const due: WaitRow[] = [];
  for (const ns of namespaces) {
    const timerParams: unknown[] = [];
    const timerPredicate = nsPredicateFor('waits', ns, timerParams);
    const timerRows = await pool.query<WaitRow>(
      `SELECT id, run_id, project_id, env, step_seq, fingerprint, kind, child_run_id
         FROM waits
        WHERE status = 'pending'
          AND kind IN ('duration','until')
          AND resume_at <= now()
          AND ${timerPredicate}
        ORDER BY resume_at ASC
        LIMIT 50`,
      timerParams,
    );
    const orphanParams: unknown[] = [];
    const orphanPredicate = nsPredicateFor('waits', ns, orphanParams);
    const orphanRows = await pool.query<WaitRow>(
      `SELECT id, run_id, project_id, env, step_seq, fingerprint, kind, child_run_id
         FROM waits
        WHERE status = 'pending'
          AND kind = 'run'
          AND child_run_id IS NULL
          AND ${orphanPredicate}
        ORDER BY id ASC
        LIMIT 10`,
      orphanParams,
    );
    due.push(...timerRows.rows, ...orphanRows.rows);
  }
  return due;
}

// p1-37 wait-graph invariant scans (read-only, no locks — phase 1 only).
// Both conditions are impossible in a healthy system: a 'waiting' run
// always has a pending wait (suspendRun / waitForChildRun write the pair
// in ONE tx), and a pending 'run' wait is always resolved by the child's
// terminal tx before that tx commits. Finding either means a wake was
// lost — count it and say it out loud rather than let the parent wait
// forever in silence. Independent LIMITs so neither class can crowd the
// other out of the window (same reasoning as the timer/orphan split).
async function scanNoWaitRuns(
  pool: Pool,
  namespaces: readonly Namespace[],
): Promise<number> {
  let noWaitRuns = 0;
  for (const ns of namespaces) {
    const noWaitParams: unknown[] = [];
    const noWaitPredicate = nsPredicateFor('r', ns, noWaitParams);
    const noWaitRows = await pool.query<{ id: string }>(
      `SELECT r.id FROM runs r
        WHERE r.status = 'waiting'
          AND ${noWaitPredicate}
          AND NOT EXISTS (
            SELECT 1 FROM waits w
             WHERE w.run_id = r.id AND w.project_id = r.project_id AND w.env = r.env
               AND w.status = 'pending'
          )
        LIMIT 10`,
      noWaitParams,
    );
    noWaitRuns += noWaitRows.rows.length;
  }
  return noWaitRuns;
}

async function scanStuckWaits(
  pool: Pool,
  namespaces: readonly Namespace[],
): Promise<number> {
  let stuckWaits = 0;
  for (const ns of namespaces) {
    const stuckParams: unknown[] = [];
    const stuckPredicate = nsPredicateFor('w', ns, stuckParams);
    const stuckRows = await pool.query<{ id: number }>(
      `SELECT w.id FROM waits w
        WHERE w.kind = 'run' AND w.status = 'pending' AND w.child_run_id IS NOT NULL
          AND ${stuckPredicate}
          AND EXISTS (
            SELECT 1 FROM runs c
             WHERE c.id = w.child_run_id
               AND c.status IN ('completed','failed','canceled')
          )
        LIMIT 10`,
      stuckParams,
    );
    stuckWaits += stuckRows.rows.length;
  }
  return stuckWaits;
}

// Phase 2 — one short tx per wait, acquiring the canonical lock order
// (queue → runs → wait row; see runs.ts header) and re-checking the wait
// under its lock: a concurrent cancel or another orchestrator instance may
// have resolved it between the phases. Per-wait txs keep each tx's lock
// footprint to a single run, so scanners can never cross-deadlock.
//
// Phase 1 holds nothing, so every daemon reads the same due rows. Positions
// 2 and 3 therefore take their locks with SKIP LOCKED: a wait another
// instance is already resuming is skipped outright instead of blocking
// until its tx commits only to find the wait no longer 'pending'. Skipping
// cannot lose a resume — the row is still 'pending' with resume_at in the
// past, and phase 1 orders by resume_at, so the very next tick puts it back
// at the head of the batch. Nor can it double-resume: the run row is the
// serialization point (every path that touches a wait holds it first), so
// exactly one instance gets past it, and it re-checks status under the
// lock. Position 1 stays blocking — see the runs.ts header for why.
async function resumeOneWait(pool: Pool, logger: KernelLogger, w: WaitRow): Promise<void> {
  const wNs: Namespace = { projectId: w.project_id, env: w.env };
  await withTx(pool, async (client) => {
    await client.query(
      `SELECT run_id FROM queue WHERE run_id = $1 AND project_id = $2 AND env = $3 FOR UPDATE`,
      [w.run_id, wNs.projectId, wNs.env],
    );
    const run = await tryLockRunRow(client, w.run_id, wNs);
    if (!run) return; // run vanished, or another instance has it — next tick
    // NOTE the predicate order: the row-lock clause must stay LAST in the
    // statement. (A C2 regression once appended `AND project_id = ...`
    // after `FOR UPDATE SKIP LOCKED`, which is a 42601 syntax error on
    // every Postgres and silently broke ALL wait resumes — the orphan
    // recovery branch below would sit behind the same broken statement.)
    const lockedWait = await client.query<{ id: number }>(
      `SELECT id FROM waits WHERE id = $1 AND status = 'pending'
         AND project_id = $2 AND env = $3
       FOR UPDATE SKIP LOCKED`,
      [w.id, wNs.projectId, wNs.env],
    );
    if (!lockedWait.rows[0]) return; // already resumed/canceled, or held

    // Orphan run-wait recovery (C5, todos/01-correctness.md): the wait's
    // child run was deleted out from under it — waits.child_run_id is
    // ON DELETE SET NULL, so a pending `kind = 'run'` wait with a NULL
    // child_run_id can only mean the child vanished (a live child's wait
    // always carries its id, and wakeParentIfWaiting resolves the wait the
    // moment the child goes terminal). The parent can never be woken by a
    // result that no longer exists; without this it would sit 'waiting'
    // forever (no wait, no queue row, no path back). Fail it like a lost
    // worker: terminalFail records the reason, cancels the run's pending
    // waits (this one included) and wakes the parent's own parent if any.
    if (w.kind === 'run') {
      if (run.status === 'waiting') {
        await terminalFail(client, run, {
          name: 'ChildLostError',
          message:
            `child run was deleted before it finished (waits.child_run_id is NULL) — ` +
            `no result can ever arrive; parent failed`,
        });
        // The wait's run went terminal: wake its result waiters, and the
        // claim loops if it may have woken a parent of its own.
        await notifyTerminal(client, w.run_id, wNs);
        if (run.parent_run_id) await notifyWork(client);
      } else {
        // Defensive: a run that is not 'waiting' cannot be stranded by its
        // wait — never clobber its state, just retire the stale wait row.
        await client.query(
          `UPDATE waits SET status = 'canceled' WHERE id = $1
             AND project_id = $2 AND env = $3`,
          [w.id, wNs.projectId, wNs.env],
        );
      }
      return;
    }

    // Timer resume with the expected-old-state predicate (p2-39): a due
    // timer wait may only flip a run that is actually 'waiting'. The run
    // row is held above, so the predicate is belt-and-braces; the affected
    // row count is what must decide — a 0-row flip means the wait is stale
    // (the run went terminal/canceled/desynced on some other path), and
    // the run must NOT be resurrected: retire the wait, write nothing to
    // the ledger, enqueue nothing, notify nobody.
    const flip = await client.query(
      `UPDATE runs SET status = 'queued', updated_at = now()
        WHERE id = $1 AND project_id = $2 AND env = $3 AND status = 'waiting'`,
      [w.run_id, wNs.projectId, wNs.env],
    );
    if (flip.rowCount !== 1) {
      await client.query(
        `UPDATE waits SET status = 'canceled' WHERE id = $1
           AND project_id = $2 AND env = $3`,
        [w.id, wNs.projectId, wNs.env],
      );
      // The run's queue row (position 1 — held since the top of this tx)
      // is stale too when the run is terminal: a terminal run must carry
      // no queue row, and this is the one path that holds the row while
      // knowing the run is terminal, so delete it in the SAME lock order
      // instead of leaving inert garbage behind.
      const terminal = ['completed', 'failed', 'canceled'].includes(run.status);
      if (terminal) {
        await client.query(
          `DELETE FROM queue WHERE run_id = $1 AND project_id = $2 AND env = $3`,
          [w.run_id, wNs.projectId, wNs.env],
        );
      }
      logger.warn(
        `[orchestrator:waits] stale timer wait ${w.id} on run ${w.run_id} ` +
          `(runs.status '${run.status}', not 'waiting') — wait canceled, ` +
          `${terminal ? 'stale queue row deleted, ' : ''}run untouched`,
      );
      return;
    }

    await client.query(
      `UPDATE waits SET status = 'completed' WHERE id = $1
         AND project_id = $2 AND env = $3`,
      [w.id, wNs.projectId, wNs.env],
    );
    // upsertStep applies the C1 immutability rule (a completed row is never
    // overwritten), and the fingerprint is the one the executor computed at
    // suspend time — not something recomputed from resume_at, which would
    // drift whenever the wait's declared duration differs from the elapsed
    // wall-clock time.
    const outcome = await upsertStep(client, {
      runId: w.run_id,
      namespace: wNs,
      seq: w.step_seq,
      kind: 'wait',
      label: undefined, // the ledger row stores NULL (upsertStep binds ?? null)
      status: 'completed',
      output: null,
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      fingerprint: w.fingerprint ?? undefined,
    });
    // Defensive: the wait step's output is a literal null, so the write
    // cannot actually fail its serialization check. If it ever does, do
    // NOT leave the wait 'completed' with a missing step row — roll the
    // resume back (the run stays 'waiting') and let the orchestrator's
    // loop error counter/log surface it, instead of silently desyncing
    // the ledger.
    if (!outcome.ok) throw new KernelError(outcome.code, outcome.message);
    // Re-enqueue through the shared enqueue() (p2-30), NOT a hand-rolled
    // INSERT: "put a run back in the queue" is one concept, one SQL shape.
    // Priority comes off the runs row, not a literal: suspendRun deleted the
    // queue row that held it, so this is usually the INSERT branch, and a
    // hard-coded 0 would silently demote every timer wait — a priority-10
    // run that slept an hour would come back at the tail of the queue
    // (todos/01-correctness.md C7). `preserveSurvivor: true` keeps a
    // surviving queue row's OWN priority/concurrency_key: reaching the
    // conflict branch means a row survived the suspend, and that row's
    // value is then the more trustworthy of the two.
    await enqueue(client, {
      runId: w.run_id,
      availableAt: new Date(),
      priority: run.priority,
      concurrencyKey: run.concurrency_key,
      namespace: wNs,
      preserveSurvivor: true,
    });
    // The resumed run is claimable again — wake the claim loops. This is
    // the "resume → work" notification PF2 asks for; a resume that rolled
    // back (or an early no-op return above) sends nothing.
    await notifyWork(client);
  });
}

export function startOrchestrator(
  pool: Pool,
  logger: KernelLogger,
  opts: OrchestratorOptions = {},
  waitGraph?: WaitGraphCounters,
): OrchestratorHandle {
  const timerIntervalMs = opts.timerIntervalMs ?? 1_000;
  const cronIntervalMs = opts.cronIntervalMs ?? 1_000;
  const reaperIntervalMs = opts.reaperIntervalMs ?? 10_000;

  const gcIntervalMs = opts.gcIntervalMs ?? GC_INTERVAL_MS;
  const retentionMs = opts.retentionMs;
  const strandedIntervalMs = opts.strandedIntervalMs ?? STRANDED_SCAN_MS;

  // The one boundary default in the kernel: absent config means the legacy
  // single-namespace world ('default'/'prod'). Every loop below filters on
  // these pairs and never defaults again.
  //
  // The hot scans (waits/cron/reaper) do NOT build one predicate over all
  // namespaces here anymore: with ≥2 namespaces the `IN (VALUES …)` form is a
  // semi-join that loses the equality constraints on the (project_id, env)
  // index prefix and every scan degrades to sorting the whole backlog
  // (todos/02-performance.md p1-08). Each loop scans PER NAMESPACE instead —
  // one query per namespace, each a single-namespace equality the index can
  // bind, results concatenated — via nsPredicateFor() with a fresh params
  // array per namespace (each query renumbers $1..$2).
  const namespaces: readonly Namespace[] = (opts.namespaces ?? [DEFAULT_NAMESPACE]).map(
    (ns) => {
      assertNamespace(ns);
      return ns;
    },
  );

  const timers: NodeJS.Timeout[] = [];
  const running = {
    waits: false,
    cron: false,
    reaper: false,
    workers: false,
    gc: false,
    stranded: false,
  };
  const counters = createOrchestratorCounters();
  // p1-37: the wait-graph invariant counters live on the kernel handle
  // (createKernel owns and exposes them); a caller that bypassed createKernel
  // still gets the violation LOGS below, just not the counts.
  const waitGraphCounters: WaitGraphCounters = waitGraph ?? {
    waitingWithoutPendingWait: 0,
    terminalChildPendingWait: 0,
    cycleRejected: 0,
  };
  // Violations are persistent conditions by nature, so the scanner logs
  // TRANSITIONS (like the stranded loop), not a line per tick; the counters
  // above are per-tick gauges ("how many right now") — see the fold site
  // below. Starts at the all-clear signature so the first clean tick does not
  // log a phantom "recovery".
  let lastWaitGraphSignature = '0/0';
  const logWaitGraphViolations = (noWaitRuns: number, stuckWaits: number): void => {
    const signature = `${noWaitRuns}/${stuckWaits}`;
    if (signature === lastWaitGraphSignature) return;
    lastWaitGraphSignature = signature;
    if (noWaitRuns === 0 && stuckWaits === 0) {
      logger.warn(`[orchestrator:wait-graph] no wait-graph violations remain`);
      return;
    }
    const parts: string[] = [];
    if (noWaitRuns > 0) parts.push(`${noWaitRuns}+ 'waiting' run(s) with no pending wait`);
    if (stuckWaits > 0) parts.push(`${stuckWaits}+ pending wait(s) on an already-terminal child`);
    logger.error(
      `[orchestrator:wait-graph] ${parts.join('; ')} — a parent wake was lost (p1-37)`,
    );
  };
  let stopped = false;

  function loop(
    key: keyof typeof running,
    intervalMs: number,
    fn: () => Promise<void>,
  ): void {
    const tick = async () => {
      if (stopped || running[key]) return;
      running[key] = true;
      try {
        await fn();
        // A tick that completes stamps its last-success gauge; when a loop
        // hangs (e.g. a queue-row lock with no statement_timeout) this stops
        // advancing, which is the only signal that the loop died silently —
        // the re-entrancy guard swallows later ticks and loopErrors stays 0.
        counters.loopLastSuccess[key] = Date.now();
      } catch (err) {
        // Keep loops alive; surface for debugging.
        counters.loopErrors[key] += 1;
        logger.error(`[orchestrator:${key}]`, err);
      } finally {
        running[key] = false;
      }
    };
    timers.push(setInterval(tick, intervalMs));
  }

  /* ------------------------------------------------------------------ waits */
  async function scanWaits(): Promise<void> {
    // p1-37 wait-graph invariant tallies, accumulated across namespaces and
    // folded into the shared counters + transition log after the loop.
    const dueRows = await scanDueWaits(pool, namespaces);
    const noWaitRuns = await scanNoWaitRuns(pool, namespaces);
    const stuckWaits = await scanStuckWaits(pool, namespaces);

    // Fold the tallies into the shared counters as PER-TICK GAUGES (p1-37):
    // each tick ASSIGNS the violation count it just observed. A persistent
    // stuck row must read as a stable level (1 row = 1, tick after tick), not
    // as a rate climbing by one every second — the transition LOG below is
    // what makes a newly-stuck row stand out, not a counter that only grows.
    waitGraphCounters.waitingWithoutPendingWait = noWaitRuns;
    waitGraphCounters.terminalChildPendingWait = stuckWaits;
    logWaitGraphViolations(noWaitRuns, stuckWaits);

    for (const w of dueRows) {
      await resumeOneWait(pool, logger, w);
    }
  }

  /* ------------------------------------------------------------------- cron */
  async function scanCron(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Namespace-scoped: a staging daemon fires only staging schedules, and
      // the schedule's project_id rides along so the run is created in the
      // schedule's own namespace (C2). The due-scan runs PER NAMESPACE
      // (todos/02-performance.md p1-08): one query per namespace with its own
      // fresh params array, LIMIT 50 each, results concatenated — per-namespace
      // equalities bind the (project_id, env) index prefix, where one VALUES
      // query over all namespaces becomes a semi-join that loses the
      // equalities and sorts the whole backlog.
      type ScheduleRow = {
        id: string;
        task_id: string;
        cron_pattern: string;
        cron_tz: string | null;
        project_id: string;
        env: string;
        db_now: Date;
      };
      const due = { rows: [] as ScheduleRow[] };
      for (const ns of namespaces) {
        const params: unknown[] = [];
        const predicate = nsPredicateFor('schedules', ns, params);
        const res = await client.query<ScheduleRow>(
          `SELECT id, task_id, cron_pattern, cron_tz, project_id, env, now() AS db_now
             FROM schedules
            WHERE enabled = true AND next_run_at IS NOT NULL AND next_run_at <= now()
              AND ${predicate}
            ORDER BY next_run_at ASC
            LIMIT 50
            FOR UPDATE SKIP LOCKED`,
          params,
        );
        due.rows.push(...res.rows);
      }

      for (const s of due.rows) {
        // Create + enqueue through the shared path so retry policy and
        // concurrency key resolve exactly like any other trigger.
        const created = await createRunIn(client, {
          taskId: s.task_id,
          payload: null,
          triggerType: 'schedule',
          namespace: { projectId: s.project_id, env: s.env },
        });

        // Next fire computed from the DATABASE clock (p1-09) — computing the
        // next fire from the daemon clock could write a next_run_at the DB
        // still sees as due, re-firing the same schedule every tick under
        // clock skew. Computing from db_now (the clock that judged it due)
        // keeps the two decisions on one clock, and missed windows are skipped
        // (no catch-up).
        const next = nextCronAt(s.cron_pattern, s.cron_tz ?? undefined, s.db_now);
        // Second defense: whatever the computation above did, a schedule can
        // never be immediately re-due right after firing — the clamp keeps a
        // skewed daemon clock from writing a next_run_at the DB reads as
        // already past. The NULL guard matters: nextCronAt returns null for an
        // impossible pattern (e.g. "0 0 30 2 *"), and GREATEST would otherwise
        // turn that into now()+1s and fire an impossible schedule every tick
        // forever instead of leaving it silent.
        await client.query(
          `UPDATE schedules
              SET last_run_at = now(), last_run_id = $2,
                  next_run_at = CASE
                    WHEN $3::timestamptz IS NULL THEN NULL
                    ELSE GREATEST($3::timestamptz, now() + interval '1 second')
                  END,
                  updated_at = now()
            WHERE id = $1 AND project_id = $4 AND env = $5`,
          [s.id, created.runId, next, s.project_id, s.env],
        );
      }
      // At least one schedule fired in this tx → wake the claim loops with a
      // single aggregate `work` notification (see runs.ts batchTrigger).
      if (due.rows.length > 0) await notifyWork(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /* ----------------------------------------------------------------- reaper */
  async function reap(): Promise<void> {
    const client = await pool.connect();
    // Tallied locally and folded into the shared counters only after COMMIT —
    // a tx that rolls back recovered nothing, and a metric that counts the
    // attempt would report recoveries that never happened. Same for the
    // notifications: they are sent inside the tx, so a rollback delivers none.
    let requeued = 0;
    let failed = 0;
    // (runId, namespace, hasParent) of the runs this tick failed terminally —
    // for the per-run `terminal` notifications sent before COMMIT.
    const failedTerminal: Array<{ runId: string; qNs: Namespace; hasParent: boolean }> = [];
    try {
      await client.query('BEGIN');
      // `lease_until IS NOT NULL` is redundant against `<= now()`, and not
      // load-bearing for the plan: PG derives it from the comparison itself
      // (NULL never compares true) and picks the *partial*
      // queue_lease_until_idx either way — checked on 16.2. It is spelled out
      // so the predicate matches that index's WHERE verbatim, stating "the
      // in-flight subset" instead of relying on the planner's inference.
      // ORDER BY matches that index's key order (no sort node) and, with the
      // LIMIT, makes the batch the OLDEST expired leases — see REAP_BATCH.
      // Namespace-scoped: a daemon only reaps leases it is configured for
      // (C2); project_id/env ride along for the per-row statements below. The
      // scan runs PER NAMESPACE (todos/02-performance.md p1-08): one query per
      // namespace with its own fresh params array, LIMIT REAP_BATCH each,
      // results concatenated — per-namespace equalities bind the
      // (project_id, env) index prefix, where one VALUES query over all
      // namespaces becomes a semi-join that loses the equalities and sorts the
      // whole backlog.
      type StaleRow = {
        id: number;
        run_id: string;
        project_id: string;
        env: string;
      };
      const stale = { rows: [] as StaleRow[] };
      for (const ns of namespaces) {
        const params: unknown[] = [];
        const predicate = nsPredicateFor('q', ns, params);
        const res = await client.query<StaleRow>(
          `SELECT q.id, q.run_id, q.project_id, q.env
             FROM queue q
            WHERE q.lease_until IS NOT NULL
              AND q.lease_until <= now()
              AND ${predicate}
            ORDER BY q.lease_until ASC
            LIMIT ${REAP_BATCH}
            FOR UPDATE SKIP LOCKED`,
          params,
        );
        stale.rows.push(...res.rows);
      }

      for (const q of stale.rows) {
        const qNs: Namespace = { projectId: q.project_id, env: q.env };
        // Queue row already held via SKIP LOCKED → lock the runs row second
        // (canonical order; see runs.ts header).
        const run = await lockRunRow(client, q.run_id, qNs);
        if (!run) {
          // A leased queue row whose run does not exist anymore — nothing to
          // requeue, nothing to fail; the row itself is the stale part (p2-39
          // §2: queue rows without a corresponding run are deleted, and the
          // deletion is worth saying out loud).
          await client.query(
            `DELETE FROM queue WHERE id = $1 AND project_id = $2 AND env = $3`,
            [q.id, qNs.projectId, qNs.env],
          );
          logger.warn(
            `[orchestrator:reaper] stale queue row ${q.id} for missing run ${q.run_id} ` +
              `— queue row deleted`,
          );
          continue;
        }
        // Expected-old-state guard (p2-39): an expired lease belongs to a run
        // this reaper (or a dead worker) was EXECUTING — 'running'. A stale
        // lease on anything else is a desynced row the public API can never
        // commit, and neither branch below may transition it: a terminal run
        // keeps its state and only its leftover queue row goes; a
        // 'queued'/'waiting' run just has the stale claim cleared (no recovery
        // spent, no status touched).
        if (run.status !== 'running') {
          if (['completed', 'failed', 'canceled'].includes(run.status)) {
            await client.query(
              `DELETE FROM queue WHERE id = $1 AND project_id = $2 AND env = $3`,
              [q.id, qNs.projectId, qNs.env],
            );
          } else {
            await client.query(
              `UPDATE queue
                  SET locked_by = NULL, locked_at = NULL, lease_until = NULL, available_at = now()
                WHERE id = $1 AND project_id = $2 AND env = $3`,
              [q.id, qNs.projectId, qNs.env],
            );
          }
          logger.warn(
            `[orchestrator:reaper] stale lease on queue row ${q.id} for run ${q.run_id} ` +
              `(runs.status '${run.status}', not 'running') — ` +
              `queue row ${['completed', 'failed', 'canceled'].includes(run.status) ? 'deleted' : 'released'}, ` +
              `run untouched`,
          );
          continue;
        }
        // A lost worker is infrastructure, not the user's code failing: it
        // spends `recoveries`, never `attempt`. maxAttempts:3 means "my code
        // may throw three times", and three deploys must not consume it (see
        // todos/01-correctness.md C4). max_recoveries is the separate, much
        // wider ceiling that still stops a run which kills every worker that
        // claims it from cycling forever.
        if (run.recoveries >= run.max_recoveries) {
          // Terminal 'worker lost' — same wrap-up as failRun so a waiting
          // parent gets woken instead of hanging forever. The message spells
          // out WHICH budget ran out: this run never spent an attempt, so
          // "worker lost" alone would read like the user's code failed.
          await terminalFail(client, run, {
            name: 'WorkerLostError',
            message:
              `worker lost: recovery budget exhausted ` +
              `(${run.recoveries}/${run.max_recoveries} infrastructure recoveries used; ` +
              `attempt ${run.attempt}/${run.max_attempts} unaffected)`,
          });
          failed += 1;
          failedTerminal.push({ runId: q.run_id, qNs, hasParent: run.parent_run_id !== null });
        } else {
          // `AND status = 'running'` is belt-and-braces on the guard above
          // (the row is held, so no one else can move it in between).
          await client.query(
            `UPDATE runs
                SET status = 'queued', recoveries = recoveries + 1, updated_at = now()
              WHERE id = $1 AND project_id = $2 AND env = $3 AND status = 'running'`,
            [q.run_id, qNs.projectId, qNs.env],
          );
          // Release the claim. runs.fencing_token is deliberately untouched —
          // the next claim's token++ is what invalidates the lost worker's
          // writes.
          await client.query(
            `UPDATE queue SET locked_by = NULL, locked_at = NULL, lease_until = NULL, available_at = now()
              WHERE id = $1 AND project_id = $2 AND env = $3`,
            [q.id, qNs.projectId, qNs.env],
          );
          requeued += 1;
        }
      }
      // Inside the tx, so only a COMMIT delivers them: requeued runs are
      // claimable again (`work`), worker-lost runs went terminal (`terminal`,
      // plus `work` when the terminal-fail woke a waiting parent).
      if (requeued > 0) await notifyWork(client);
      for (const t of failedTerminal) {
        await notifyTerminal(client, t.runId, t.qNs);
        if (t.hasParent) await notifyWork(client);
      }
      await client.query('COMMIT');
      counters.reaperRequeued += requeued;
      counters.reaperFailed += failed;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /* ---------------------------------------------------------------- workers */
  async function markOfflineWorkers(): Promise<void> {
    await pool.query(
      `UPDATE workers
          SET status = 'offline'
        WHERE status = 'online'
          AND last_heartbeat_at < now() - ($1::text || ' milliseconds')::interval`,
      [String(WORKER_OFFLINE_MS)],
    );
  }

  /* ---------------------------------------------------------------- gc */
  /**
   * Retention sweep (todos/02-performance.md PF6). Same body as the CLI's
   * `prune` subcommand — one implementation, so "what the daemon deletes" and
   * "what prune deletes" cannot drift apart. Reported at info-level through the
   * logger's warn sink only when it actually removed something: a silent GC and
   * a broken GC must not look the same in a log, but an hourly "deleted 0 rows"
   * line is noise.
   */
  async function gc(): Promise<void> {
    if (retentionMs === undefined) return;
    const res = await prune(pool, { olderThanMs: retentionMs, namespaces });
    counters.gcRunsDeleted += res.runs;
    counters.gcWorkersDeleted += res.workers;
    if (res.runs > 0 || res.workers > 0) {
      logger.warn(
        `[orchestrator:gc] retention ${retentionMs}ms: deleted ${res.runs} run(s), ` +
          `${res.runSteps} step(s), ${res.logs} log(s), ${res.workers} worker row(s) ` +
          `older than ${res.cutoff.toISOString()}`,
      );
    }
  }

  /* ---------------------------------------------------------------- stranded */
  /**
   * Version-pinned runs that no online worker can claim (see scanStrandedRuns).
   * Publishes the level on `counters.stranded` for /metrics, and says it out
   * loud when the picture *changes*: the condition persists by nature, so a
   * line per tick would be noise, while a line only on the way in would leave
   * "is it still stuck?" unanswered. Recovery (the version comes back, the runs
   * drain) gets its own line for the same reason.
   */
  async function scanStranded(): Promise<void> {
    const scan = await scanStrandedRuns(pool, namespaces);
    const before = counters.stranded;
    counters.stranded = scan;
    if (signatureOf(before) === signatureOf(scan)) return;

    if (scan.groups.length === 0) {
      logger.warn(`[orchestrator:stranded] no runs are stranded on a missing code version`);
      return;
    }
    const total = scan.groups.reduce((n, g) => n + g.count, 0);
    const detail = scan.groups
      .map((g) => `${g.taskId}@${g.codeVersion}: ${g.count}`)
      .join(', ');
    logger.warn(
      `[orchestrator:stranded] ${total}${scan.truncated ? '+' : ''} due run(s) pinned to a ` +
        `code version no online worker serves — they stay queued until one does. ` +
        `Start a worker on that build, or re-trigger the work under the current one. ` +
        `(${detail}${scan.truncated ? ', …' : ''})`,
    );
  }

  if (opts.waits ?? true) loop('waits', timerIntervalMs, scanWaits);
  if (opts.cron ?? true) loop('cron', cronIntervalMs, scanCron);
  if (opts.reaper ?? true) loop('reaper', reaperIntervalMs, reap);
  if (opts.workerOffline ?? true) loop('workers', WORKER_OFFLINE_SCAN_MS, markOfflineWorkers);
  // No `?? true` here, and no default window above: the retention loop exists
  // only when a window was asked for.
  if (retentionMs !== undefined) loop('gc', gcIntervalMs, gc);
  // Likewise off by default — it only has something true to say under pinning.
  if (opts.stranded === true) loop('stranded', strandedIntervalMs, scanStranded);

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
    counters,
  };
}
