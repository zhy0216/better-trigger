/* =============================================================================
   @better-trigger/kernel — kernel background orchestrator.
   Four interval loops (each with re-entrancy guards, each individually
   switchable via OrchestratorOptions — all default on):
     1. wait-due scanner   (timerIntervalMs, 1s)   — resume duration/until waits
     2. cron scheduler     (cronIntervalMs, 1s)    — fire due schedules via
        createRunIn (task retry policy resolved like any other trigger)
     3. lease reaper       (reaperIntervalMs, 10s) — recover runs whose
        lease_until has expired (spends runs.recoveries, never runs.attempt —
        losing a worker is infrastructure, not the user's code failing)
     4. worker offline marker (30s)                — mark workers with no
        heartbeat > 2m
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
import { createRunIn, lockRunRow, terminalFail, tryLockRunRow, withTx } from './runs';

const WORKER_OFFLINE_MS = 120_000;
const WORKER_OFFLINE_SCAN_MS = 30_000;

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
  /** Loop iterations that threw, per loop. Each one is logged too, but a rate
   *  is what says "the cron loop has been failing all afternoon". */
  loopErrors: { waits: number; cron: number; reaper: number; workers: number };
}

export function createOrchestratorCounters(): OrchestratorCounters {
  return {
    reaperRequeued: 0,
    reaperFailed: 0,
    loopErrors: { waits: 0, cron: 0, reaper: 0, workers: 0 },
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

  const timers: NodeJS.Timeout[] = [];
  const running = { waits: false, cron: false, reaper: false, workers: false };
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
    const due = await pool.query<{ id: number; run_id: string; step_seq: number }>(
      `SELECT id, run_id, step_seq
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
        await client.query(
          `INSERT INTO run_steps
             (run_id, seq, kind, label, status, output, attempt, started_at, finished_at)
           VALUES ($1,$2,'wait',NULL,'completed',NULL,1, now(), now())
           ON CONFLICT (run_id, seq) DO UPDATE
             SET status = 'completed', finished_at = now()`,
          [w.run_id, w.step_seq],
        );
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
        `SELECT q.id, q.run_id
           FROM queue q
          WHERE q.lease_until IS NOT NULL
            AND q.lease_until <= now()
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

  if (opts.waits ?? true) loop('waits', timerIntervalMs, scanWaits);
  if (opts.cron ?? true) loop('cron', cronIntervalMs, scanCron);
  if (opts.reaper ?? true) loop('reaper', reaperIntervalMs, reap);
  if (opts.workerOffline ?? true) loop('workers', WORKER_OFFLINE_SCAN_MS, markOfflineWorkers);

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
    counters,
  };
}
