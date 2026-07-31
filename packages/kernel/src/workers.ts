/* =============================================================================
   @better-trigger/kernel — kernel worker registration.
   registerWorker inserts the worker row and, in the same transaction, upserts
   every task definition and syncs cron schedules (preserving the enabled flag
   of existing schedules); deregisterWorker marks the row offline on the way
   out. See docs/backend-contract.md §3.6.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { KernelError, type TaskManifest } from '@better-trigger/core';
import { scheduleId as genScheduleId, workerId as genWorkerId } from './ids';
import { nextCronAt } from './orchestrator';

export interface RegisterWorkerArgs {
  name?: string;
  codeVersion: string;
  runtime: string;
  concurrency: number;
  tasks: TaskManifest[];
}

/**
 * Register a worker process: insert the workers row, upsert its task
 * definitions and sync schedules — one transaction. Returns the new worker id.
 */
export async function registerWorker(
  pool: Pool,
  args: RegisterWorkerArgs,
): Promise<{ workerId: string }> {
  if (!Array.isArray(args.tasks)) {
    throw new KernelError('bad_request', 'tasks must be an array');
  }
  for (const t of args.tasks) {
    if (typeof t?.id !== 'string' || t.id.length === 0) {
      throw new KernelError('bad_request', 'task.id must be a non-empty string');
    }
  }
  const id = genWorkerId();
  const taskIds = args.tasks.map((t) => t.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert worker row.
    await client.query(
      `INSERT INTO workers
         (id, name, code_version, runtime, tasks, concurrency, started_at, last_heartbeat_at, status)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now(), 'online')`,
      [
        id,
        args.name ?? null,
        args.codeVersion,
        args.runtime,
        JSON.stringify(taskIds),
        args.concurrency,
      ],
    );

    // Upsert each task definition.
    for (const t of args.tasks) {
      await upsertTask(client, t, args.codeVersion);
    }

    // Sync schedules: upsert cron tasks (preserve enabled), delete others.
    await syncSchedules(client, args.tasks);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { workerId: id };
}

export interface DeregisterWorkerArgs {
  workerId: string;
}

/**
 * Mark a worker offline on the way out (todos/01-correctness.md C3). Without
 * it the row stays 'online' until the orchestrator's offline marker notices the
 * missing heartbeat — two minutes during which the dashboard shows a process
 * that is already gone, right after every deploy.
 *
 * One row, one statement: no transaction, no lock-order concern (the workers
 * table takes part in no multi-row kernel tx), and idempotent — calling it
 * twice, or for a worker whose row was already marked offline, is a no-op. The
 * caller stops its heartbeat first; a heartbeat landing afterwards would set
 * the row back to 'online'.
 */
export async function deregisterWorker(
  pool: Pool,
  args: DeregisterWorkerArgs,
): Promise<void> {
  await pool.query(`UPDATE workers SET status = 'offline' WHERE id = $1`, [args.workerId]);
}

/* ---------------------------------------------------------------------------
 * Task + schedule upsert helpers
 * ------------------------------------------------------------------------- */

async function upsertTask(
  client: PoolClient,
  t: TaskManifest,
  codeVersion: string,
): Promise<void> {
  const triggerSource = t.cron ? 'schedule' : 'api';
  await client.query(
    `INSERT INTO tasks
       (id, name, file_path, trigger_source, cron_pattern, cron_tz, retry,
        concurrency_limit, latest_code_version, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), now())
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           file_path = EXCLUDED.file_path,
           trigger_source = EXCLUDED.trigger_source,
           cron_pattern = EXCLUDED.cron_pattern,
           cron_tz = EXCLUDED.cron_tz,
           retry = EXCLUDED.retry,
           concurrency_limit = EXCLUDED.concurrency_limit,
           latest_code_version = EXCLUDED.latest_code_version,
           updated_at = now()`,
    [
      t.id,
      t.name ?? t.id,
      t.filePath ?? null,
      triggerSource,
      t.cron?.pattern ?? null,
      t.cron?.timezone ?? null,
      t.retry ? JSON.stringify(t.retry) : null,
      t.concurrencyLimit ?? null,
      codeVersion,
    ],
  );
}

async function syncSchedules(
  client: PoolClient,
  tasks: TaskManifest[],
): Promise<void> {
  const cronTaskIds: string[] = [];
  for (const t of tasks) {
    if (!t.cron) continue;
    cronTaskIds.push(t.id);
    const next = nextCronAt(t.cron.pattern, t.cron.timezone);
    // Upsert by task_id (unique), preserving existing enabled flag.
    await client.query(
      `INSERT INTO schedules
         (id, task_id, cron_pattern, cron_tz, enabled, next_run_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4, true, $5, now(), now())
       ON CONFLICT (task_id) DO UPDATE
         SET cron_pattern = EXCLUDED.cron_pattern,
             cron_tz = EXCLUDED.cron_tz,
             next_run_at = CASE WHEN schedules.enabled THEN EXCLUDED.next_run_at ELSE NULL END,
             updated_at = now()`,
      [genScheduleId(), t.id, t.cron.pattern, t.cron.timezone ?? null, next],
    );
  }

  // Remove schedules for tasks this manifest no longer declares as cron.
  // Only prune schedules whose task appears in the manifest but lost its cron,
  // plus any schedule for tasks in the manifest that are not cron now.
  const manifestTaskIds = tasks.map((t) => t.id);
  if (manifestTaskIds.length > 0) {
    await client.query(
      `DELETE FROM schedules
        WHERE task_id = ANY($1::text[]) AND task_id <> ALL($2::text[])`,
      [manifestTaskIds, cronTaskIds.length > 0 ? cronTaskIds : ['']],
    );
  }
}
