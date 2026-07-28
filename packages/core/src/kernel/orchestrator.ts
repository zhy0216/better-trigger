/* =============================================================================
   @better-trigger/core — kernel background orchestrator.
   Four interval loops (each with re-entrancy guards):
     1. wait-due scanner   (timerIntervalMs, 1s)   — resume duration/until waits
     2. cron scheduler     (cronIntervalMs, 1s)    — fire due schedules via
        createRunIn (task retry policy resolved like any other trigger)
     3. lease reaper       (reaperIntervalMs, 10s) — recover runs whose
        lease_until has expired
     4. worker offline marker (30s)                — mark workers with no
        heartbeat > 2m
   See docs/backend-contract.md §3.2, §3.5, §3.6. Loop errors are swallowed
   (logged via the kernel logger) so loops never die.
   ============================================================================= */
import { Cron } from 'croner';
import type { Pool } from 'pg';
import type { KernelLogger } from './kernel';
import { createRunIn, getRunRow, terminalFail } from './runs';

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
}

export interface OrchestratorHandle {
  stop(): void;
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
        logger.error(`[orchestrator:${key}]`, err);
      } finally {
        running[key] = false;
      }
    };
    timers.push(setInterval(tick, intervalMs));
  }

  /* ------------------------------------------------------------------ waits */
  async function scanWaits(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<{
        id: number;
        run_id: string;
        step_seq: number;
        concurrency_key: string | null;
        env: string;
      }>(
        `SELECT w.id, w.run_id, w.step_seq, r.concurrency_key, r.env
           FROM waits w
           JOIN runs r ON r.id = w.run_id
          WHERE w.status = 'pending'
            AND w.kind IN ('duration','until')
            AND w.resume_at <= now()
          ORDER BY w.resume_at ASC
          LIMIT 50
          FOR UPDATE OF w SKIP LOCKED`,
      );

      for (const w of due.rows) {
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
          [w.run_id, w.concurrency_key, w.env],
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
        const run = await getRunRow(client, q.run_id);
        if (!run) {
          await client.query(`DELETE FROM queue WHERE id = $1`, [q.id]);
          continue;
        }
        if (run.attempt >= run.max_attempts) {
          // Terminal 'worker lost' — same wrap-up as failRun so a waiting
          // parent gets woken instead of hanging forever.
          await terminalFail(client, run, { message: 'worker lost' });
        } else {
          await client.query(
            `UPDATE runs
                SET status = 'queued', attempt = attempt + 1, updated_at = now()
              WHERE id = $1`,
            [q.run_id],
          );
          // Release the claim. fencing_token is deliberately NOT reset — the
          // next claim's token++ is what invalidates the lost worker's writes.
          await client.query(
            `UPDATE queue SET locked_by = NULL, locked_at = NULL, lease_until = NULL, available_at = now()
              WHERE id = $1`,
            [q.id],
          );
        }
      }
      await client.query('COMMIT');
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

  loop('waits', timerIntervalMs, scanWaits);
  loop('cron', cronIntervalMs, scanCron);
  loop('reaper', reaperIntervalMs, reap);
  loop('workers', WORKER_OFFLINE_SCAN_MS, markOfflineWorkers);

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
  };
}
