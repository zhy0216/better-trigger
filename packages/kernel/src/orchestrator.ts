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
import type { KernelLogger } from './kernel';
import { prune } from './prune';
import { scanStrandedRuns, type StrandedScan } from './queue';
import {
  createRunIn,
  lockRunRow,
  terminalFail,
  tryLockRunRow,
  upsertStep,
  withTx,
} from './runs';

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
}

export function createOrchestratorCounters(): OrchestratorCounters {
  return {
    reaperRequeued: 0,
    reaperFailed: 0,
    gcRunsDeleted: 0,
    gcWorkersDeleted: 0,
    stranded: { groups: [], truncated: false },
    loopErrors: { waits: 0, cron: 0, reaper: 0, workers: 0, gc: 0, stranded: 0 },
  };
}

export interface OrchestratorHandle {
  stop(): void;
  /** Loop counters, live for the lifetime of this handle. Read, never written,
   *  by whoever exports metrics. */
  counters: OrchestratorCounters;
}

export function startOrchestrator(
  pool: Pool,
  logger: KernelLogger,
  opts: OrchestratorOptions = {},
): OrchestratorHandle {
  const timerIntervalMs = opts.timerIntervalMs ?? 1_000;
  const cronIntervalMs = opts.cronIntervalMs ?? 1_000;
  const reaperIntervalMs = opts.reaperIntervalMs ?? 10_000;

  const gcIntervalMs = opts.gcIntervalMs ?? GC_INTERVAL_MS;
  const retentionMs = opts.retentionMs;
  const strandedIntervalMs = opts.strandedIntervalMs ?? STRANDED_SCAN_MS;

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
    // Phase 1 — discover due timer waits with a plain read, holding no locks.
    // fingerprint rides along: the executor computed it from the DECLARED wait
    // (duration string / until instant) when it suspended, and the resume must
    // stamp the completed step row with that same value (C1).
    const due = await pool.query<{
      id: number;
      run_id: string;
      step_seq: number;
      fingerprint: string | null;
    }>(
      `SELECT id, run_id, step_seq, fingerprint
         FROM waits
        WHERE status = 'pending'
          AND kind IN ('duration','until')
          AND resume_at <= now()
        ORDER BY resume_at ASC
        LIMIT 50`,
    );

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
    for (const w of due.rows) {
      await withTx(pool, async (client) => {
        await client.query(`SELECT run_id FROM queue WHERE run_id = $1 FOR UPDATE`, [
          w.run_id,
        ]);
        const run = await tryLockRunRow(client, w.run_id);
        if (!run) return; // run vanished, or another instance has it — next tick
        const lockedWait = await client.query<{ id: number }>(
          `SELECT id FROM waits WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
          [w.id],
        );
        if (!lockedWait.rows[0]) return; // already resumed/canceled, or held

        await client.query(`UPDATE waits SET status = 'completed' WHERE id = $1`, [w.id]);
        // upsertStep applies the C1 immutability rule (a completed row is never
        // overwritten), and the fingerprint is the one the executor computed at
        // suspend time — not something recomputed from resume_at, which would
        // drift whenever the wait's declared duration differs from the elapsed
        // wall-clock time.
        await upsertStep(client, {
          runId: w.run_id,
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
        await client.query(
          `UPDATE runs SET status = 'queued', updated_at = now() WHERE id = $1`,
          [w.run_id],
        );
        // Priority comes off the runs row, not a literal: suspendRun deleted the
        // queue row that held it, so this is always the INSERT branch, and a
        // hard-coded 0 would silently demote every timer wait — a priority-10
        // run that slept an hour would come back at the tail of the queue
        // (todos/01-correctness.md C7). The conflict branch deliberately leaves
        // priority alone: reaching it means a queue row survived the suspend,
        // and that row's own value is then the more trustworthy of the two.
        await client.query(
          `INSERT INTO queue (run_id, available_at, priority, concurrency_key, env)
           VALUES ($1, now(), $2, $3, $4)
           ON CONFLICT (run_id) DO UPDATE
             SET available_at = now(), locked_by = NULL, locked_at = NULL, lease_until = NULL`,
          [w.run_id, run.priority, run.concurrency_key, run.env],
        );
      });
    }
  }

  /* ------------------------------------------------------------------- cron */
  async function scanCron(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<{
        id: string;
        task_id: string;
        cron_pattern: string;
        cron_tz: string | null;
        env: string;
      }>(
        `SELECT id, task_id, cron_pattern, cron_tz, env
           FROM schedules
          WHERE enabled = true AND next_run_at IS NOT NULL AND next_run_at <= now()
          ORDER BY next_run_at ASC
          LIMIT 50
          FOR UPDATE SKIP LOCKED`,
      );

      for (const s of due.rows) {
        // Create + enqueue through the shared path so retry policy and
        // concurrency key resolve exactly like any other trigger.
        const created = await createRunIn(client, {
          taskId: s.task_id,
          payload: null,
          triggerType: 'schedule',
          env: s.env,
        });

        // Next fire computed from now → missed windows are skipped (no catch-up).
        const next = nextCronAt(s.cron_pattern, s.cron_tz ?? undefined);
        await client.query(
          `UPDATE schedules
              SET last_run_at = now(), last_run_id = $2, next_run_at = $3, updated_at = now()
            WHERE id = $1`,
          [s.id, created.runId, next],
        );
      }
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
    // attempt would report recoveries that never happened.
    let requeued = 0;
    let failed = 0;
    try {
      await client.query('BEGIN');
      const stale = await client.query<{
        id: number;
        run_id: string;
      }>(
        // `lease_until IS NOT NULL` is redundant against `<= now()`, and not
        // load-bearing for the plan: PG derives it from the comparison itself
        // (NULL never compares true) and picks the *partial*
        // queue_lease_until_idx either way — checked on 16.2. It is spelled out
        // so the predicate matches that index's WHERE verbatim, stating "the
        // in-flight subset" instead of relying on the planner's inference.
        // ORDER BY matches that index's key order (no sort node) and, with the
        // LIMIT, makes the batch the OLDEST expired leases — see REAP_BATCH.
        `SELECT q.id, q.run_id
           FROM queue q
          WHERE q.lease_until IS NOT NULL
            AND q.lease_until <= now()
          ORDER BY q.lease_until ASC
          LIMIT ${REAP_BATCH}
          FOR UPDATE SKIP LOCKED`,
      );

      for (const q of stale.rows) {
        // Queue row already held via SKIP LOCKED → lock the runs row second
        // (canonical order; see runs.ts header).
        const run = await lockRunRow(client, q.run_id);
        if (!run) {
          await client.query(`DELETE FROM queue WHERE id = $1`, [q.id]);
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
        } else {
          await client.query(
            `UPDATE runs
                SET status = 'queued', recoveries = recoveries + 1, updated_at = now()
              WHERE id = $1`,
            [q.run_id],
          );
          // Release the claim. runs.fencing_token is deliberately untouched —
          // the next claim's token++ is what invalidates the lost worker's
          // writes.
          await client.query(
            `UPDATE queue SET locked_by = NULL, locked_at = NULL, lease_until = NULL, available_at = now()
              WHERE id = $1`,
            [q.id],
          );
          requeued += 1;
        }
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
    const res = await prune(pool, { olderThanMs: retentionMs });
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
    const scan = await scanStrandedRuns(pool);
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
