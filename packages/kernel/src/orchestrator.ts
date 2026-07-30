/* =============================================================================
   @better-trigger/kernel — kernel background orchestrator.
   Four interval loops (each with re-entrancy guards, each individually
   switchable via OrchestratorOptions — all default on):
     1. wait-due scanner   (timerIntervalMs, 1s)   — resume duration/until waits
     2. cron scheduler     (cronIntervalMs, 1s)    — fire due schedules via
        createRunIn (task retry policy resolved like any other trigger)
     3. lease reaper       (reaperIntervalMs, 10s) — recover runs whose
        lease_until has expired
     4. worker offline marker (30s)                — mark workers with no
        heartbeat > 2m
   A bookkeeping-only host (e.g. the dashboard server) runs { waits: false,
   cron: false } so it reaps leases and marks workers offline without becoming
   an execution scheduler. All loops follow the canonical kernel lock order
   (queue → runs → dependent rows; see runs.ts header).
   See docs/backend-contract.md §3.2, §3.5, §3.6. Loop errors are swallowed
   (logged via the kernel logger) so loops never die.
   ============================================================================= */
import { Cron } from 'croner';
import type { Pool } from 'pg';
import type { KernelLogger } from './kernel';
import { createRunIn, lockRunRow, terminalFail, withTx } from './runs';

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
  /** Expired-lease claims handed back to the queue (the run gets another attempt). */
  reaperRequeued: number;
  /** Expired-lease claims out of attempts → terminal 'worker lost'. */
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
    for (const w of due.rows) {
      await withTx(pool, async (client) => {
        await client.query(`SELECT run_id FROM queue WHERE run_id = $1 FOR UPDATE`, [
          w.run_id,
        ]);
        const run = await lockRunRow(client, w.run_id);
        if (!run) return; // run vanished — leave the orphan wait alone
        const lockedWait = await client.query<{ id: number }>(
          `SELECT id FROM waits WHERE id = $1 AND status = 'pending' FOR UPDATE`,
          [w.id],
        );
        if (!lockedWait.rows[0]) return; // already resumed/canceled

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
        await client.query(
          `INSERT INTO queue (run_id, available_at, priority, concurrency_key, env)
           VALUES ($1, now(), 0, $2, $3)
           ON CONFLICT (run_id) DO UPDATE
             SET available_at = now(), locked_by = NULL, locked_at = NULL, lease_until = NULL`,
          [w.run_id, run.concurrency_key, run.env],
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
        if (run.attempt >= run.max_attempts) {
          // Terminal 'worker lost' — same wrap-up as failRun so a waiting
          // parent gets woken instead of hanging forever.
          await terminalFail(client, run, { message: 'worker lost' });
          failed += 1;
        } else {
          await client.query(
            `UPDATE runs
                SET status = 'queued', attempt = attempt + 1, updated_at = now()
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
