/* =============================================================================
   @better-trigger/server — background orchestrator.
   Four interval loops (each with re-entrancy guards):
     1. wait-due scanner          (1s)  — resume duration/until waits
     2. cron scheduler            (1s)  — fire due schedules, compute next_run_at
     3. visibility-timeout reaper (10s) — recover runs locked > 60s
     4. worker offline marker     (30s) — mark workers with no heartbeat > 2m
   See docs/backend-contract.md §3.2, §3.5, §3.6.
   ============================================================================= */
import { Cron } from 'croner';
import { pool } from '../db/index';
import { runId as genRunId } from '../ids';

const VISIBILITY_TIMEOUT_MS = 60_000;
const WORKER_OFFLINE_MS = 120_000;

/** Compute the next fire time for a cron pattern, in a timezone. */
export function nextCronAt(pattern: string, timezone?: string, from?: Date): Date | null {
  const cron = new Cron(pattern, timezone ? { timezone } : {});
  return cron.nextRun(from ?? new Date());
}

export interface Orchestrator {
  start(): void;
  stop(): void;
}

export function createOrchestrator(): Orchestrator {
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
        console.error(`[orchestrator:${key}]`, err);
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
             SET available_at = now(), locked_by = NULL, locked_at = NULL`,
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
        // Resolve the task's concurrency settings for the new run.
        const taskRes = await client.query<{
          retry: unknown;
          concurrency_limit: number | null;
        }>(`SELECT retry, concurrency_limit FROM tasks WHERE id = $1`, [s.task_id]);
        const limit = taskRes.rows[0]?.concurrency_limit ?? null;
        const concurrencyKey = limit && limit > 0 ? s.task_id : null;
        const maxAttempts =
          (taskRes.rows[0]?.retry as { maxAttempts?: number } | null)?.maxAttempts ?? 3;

        const newRunId = genRunId();
        await client.query(
          `INSERT INTO runs
             (id, task_id, status, payload, trigger_type, concurrency_key,
              attempt, max_attempts, env, queued_at, created_at, updated_at)
           VALUES ($1,$2,'queued', 'null'::jsonb, 'schedule', $3, 1, $4, $5, now(), now(), now())`,
          [newRunId, s.task_id, concurrencyKey, maxAttempts, s.env],
        );
        await client.query(
          `INSERT INTO queue (run_id, available_at, priority, concurrency_key, env)
           VALUES ($1, now(), 0, $2, $3)`,
          [newRunId, concurrencyKey, s.env],
        );

        const next = nextCronAt(s.cron_pattern, s.cron_tz ?? undefined);
        await client.query(
          `UPDATE schedules
              SET last_run_at = now(), last_run_id = $2, next_run_at = $3, updated_at = now()
            WHERE id = $1`,
          [s.id, newRunId, next],
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
          WHERE q.locked_at IS NOT NULL
            AND q.locked_at < now() - ($1::text || ' milliseconds')::interval
          FOR UPDATE SKIP LOCKED`,
        [String(VISIBILITY_TIMEOUT_MS)],
      );

      for (const q of stale.rows) {
        const runRes = await client.query<{ attempt: number; max_attempts: number }>(
          `SELECT attempt, max_attempts FROM runs WHERE id = $1`,
          [q.run_id],
        );
        const run = runRes.rows[0];
        if (!run) {
          await client.query(`DELETE FROM queue WHERE id = $1`, [q.id]);
          continue;
        }
        if (run.attempt >= run.max_attempts) {
          await client.query(
            `UPDATE runs
                SET status = 'failed',
                    error = '{"message":"worker lost"}'::jsonb,
                    finished_at = now(), updated_at = now()
              WHERE id = $1`,
            [q.run_id],
          );
          await client.query(`DELETE FROM queue WHERE id = $1`, [q.id]);
        } else {
          await client.query(
            `UPDATE runs
                SET status = 'queued', attempt = attempt + 1, updated_at = now()
              WHERE id = $1`,
            [q.run_id],
          );
          await client.query(
            `UPDATE queue SET locked_by = NULL, locked_at = NULL, available_at = now()
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

  return {
    start() {
      stopped = false;
      loop('waits', 1_000, scanWaits);
      loop('cron', 1_000, scanCron);
      loop('reaper', 10_000, reap);
      loop('workers', 30_000, markOfflineWorkers);
    },
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
  };
}
