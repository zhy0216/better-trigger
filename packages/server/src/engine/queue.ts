/* =============================================================================
   @better-trigger/server — queue engine.
   Enqueue / SKIP-LOCKED dequeue (with per-task concurrency limiting) /
   lock renewal / lock release. See docs/backend-contract.md §3.5.
   Implemented with raw SQL over a single pg connection/transaction so the
   SELECT ... FOR UPDATE SKIP LOCKED semantics are exact.
   ============================================================================= */
import type { PoolClient } from 'pg';
import type { DequeuedRun, StepSnapshot } from '@better-trigger/core';
import { pool } from '../db/index';

export interface EnqueueArgs {
  client?: PoolClient;
  runId: string;
  availableAt: Date;
  priority?: number;
  concurrencyKey: string | null;
  projectId?: string;
  env?: string;
}

/** Insert (or move-back) a run into the queue. Idempotent on run_id. */
export async function enqueue(args: EnqueueArgs): Promise<void> {
  const q = args.client ?? pool;
  await q.query(
    `INSERT INTO queue (run_id, available_at, priority, concurrency_key, project_id, env, locked_by, locked_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)
     ON CONFLICT (run_id) DO UPDATE
       SET available_at = EXCLUDED.available_at,
           priority     = EXCLUDED.priority,
           concurrency_key = EXCLUDED.concurrency_key,
           locked_by    = NULL,
           locked_at    = NULL`,
    [
      args.runId,
      args.availableAt,
      args.priority ?? 0,
      args.concurrencyKey,
      args.projectId ?? 'default',
      args.env ?? 'prod',
    ],
  );
}

/** Remove a run's queue row (used on suspend / terminal). */
export async function removeFromQueue(
  runId: string,
  client?: PoolClient,
): Promise<void> {
  const q = client ?? pool;
  await q.query(`DELETE FROM queue WHERE run_id = $1`, [runId]);
}

/**
 * Try to dequeue exactly one run for the given worker.
 * Single transaction:
 *   SELECT candidates FOR UPDATE SKIP LOCKED (available + unlocked, by priority),
 *   for each candidate skip if its task is not in the worker's task set or the
 *   concurrency limit is hit, otherwise lock it (locked_by/locked_at), flip the
 *   run to running and set started_at. Returns the dequeued run + step snapshot.
 */
export async function dequeueOne(
  workerIdValue: string,
  taskIds: string[],
): Promise<DequeuedRun | null> {
  if (taskIds.length === 0) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const candidates = await client.query<{
      id: number;
      run_id: string;
      concurrency_key: string | null;
    }>(
      `SELECT q.id, q.run_id, q.concurrency_key
         FROM queue q
        WHERE q.available_at <= now() AND q.locked_at IS NULL
        ORDER BY q.priority DESC, q.id ASC
        LIMIT 10
        FOR UPDATE SKIP LOCKED`,
    );

    for (const cand of candidates.rows) {
      const runRes = await client.query<{
        id: string;
        task_id: string;
        payload: unknown;
        attempt: number;
        max_attempts: number;
        code_version: string | null;
        env: string;
        concurrency_key: string | null;
      }>(
        `SELECT id, task_id, payload, attempt, max_attempts, code_version, env, concurrency_key
           FROM runs WHERE id = $1`,
        [cand.run_id],
      );
      const run = runRes.rows[0];
      if (!run) continue;

      // Skip if the worker does not handle this task.
      if (!taskIds.includes(run.task_id)) continue;

      // Concurrency limit: read the task's limit; if set, count running runs
      // sharing the same concurrency_key (redundantly stored on runs).
      const taskRes = await client.query<{ concurrency_limit: number | null }>(
        `SELECT concurrency_limit FROM tasks WHERE id = $1`,
        [run.task_id],
      );
      const limit = taskRes.rows[0]?.concurrency_limit ?? null;
      if (limit != null && limit > 0) {
        const key = run.concurrency_key ?? run.task_id;
        // Serialize concurrent dequeues sharing this key: SKIP LOCKED does not
        // serialize two workers picking different queue rows of the same key, so
        // the count-then-flip below could race and overshoot the limit. Take a
        // tx-level advisory lock on the key first; it releases at COMMIT/ROLLBACK
        // and must be held while we count (same transaction).
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `bt:cc:${key}`,
        ]);
        const countRes = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM runs
            WHERE status = 'running' AND concurrency_key = $1`,
          [key],
        );
        const running = Number(countRes.rows[0]?.n ?? '0');
        if (running >= limit) continue; // leave it in the queue
      }

      // Lock it.
      await client.query(
        `UPDATE queue SET locked_by = $1, locked_at = now() WHERE id = $2`,
        [workerIdValue, cand.id],
      );
      await client.query(
        `UPDATE runs
            SET status = 'running',
                started_at = COALESCE(started_at, now()),
                updated_at = now()
          WHERE id = $1`,
        [run.id],
      );

      const stepsRes = await client.query<{
        seq: number;
        kind: string;
        label: string | null;
        status: string;
        output: unknown;
        error: unknown;
      }>(
        `SELECT seq, kind, label, status, output, error
           FROM run_steps WHERE run_id = $1 ORDER BY seq ASC`,
        [run.id],
      );

      await client.query('COMMIT');

      const steps: StepSnapshot[] = stepsRes.rows.map((s) => ({
        seq: s.seq,
        kind: s.kind as StepSnapshot['kind'],
        label: s.label,
        status: s.status as StepSnapshot['status'],
        output: s.output ?? undefined,
        error: (s.error as StepSnapshot['error']) ?? undefined,
      }));

      return {
        id: run.id,
        taskId: run.task_id,
        payload: run.payload,
        attempt: run.attempt,
        maxAttempts: run.max_attempts,
        codeVersion: run.code_version,
        env: run.env,
        steps,
      };
    }

    await client.query('COMMIT');
    return null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Refresh locks for the given runs owned by this worker (heartbeat).
 * Returns the run ids that have been canceled (so the worker can stop them).
 */
export async function renewLocks(
  workerIdValue: string,
  runIds: string[],
): Promise<string[]> {
  // Extend locks for runs still locked by this worker.
  if (runIds.length > 0) {
    await pool.query(
      `UPDATE queue SET locked_at = now()
        WHERE locked_by = $1 AND run_id = ANY($2::text[])`,
      [workerIdValue, runIds],
    );
  }
  await pool.query(
    `UPDATE workers SET last_heartbeat_at = now(), status = 'online' WHERE id = $1`,
    [workerIdValue],
  );

  if (runIds.length === 0) return [];
  // Any of the heartbeat's runs that are no longer 'running' → tell worker to drop.
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM runs
      WHERE id = ANY($1::text[]) AND status = 'canceled'`,
    [runIds],
  );
  return res.rows.map((r) => r.id);
}
