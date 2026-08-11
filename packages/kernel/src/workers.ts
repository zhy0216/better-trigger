/* =============================================================================
   @better-trigger/kernel — kernel worker registration.
   registerWorker inserts the worker row and, in the same transaction, upserts
   every task definition and syncs cron schedules (preserving the enabled flag
   of existing schedules); deregisterWorker marks the row offline on the way
   out. See docs/backend-contract.md §3.6.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import {
  assertNamespace,
  KernelError,
  type Namespace,
  type TaskManifest,
} from '@better-trigger/core';
import { scheduleId as genScheduleId, workerId as genWorkerId } from './ids';
import { nextCronAt } from './orchestrator';

export interface RegisterWorkerArgs {
  name?: string;
  codeVersion: string;
  runtime: string;
  concurrency: number;
  /**
   * Namespaces this worker serves (C2). The worker row stores them as a jsonb
   * `namespaces` column; its tasks and schedules are upserted in EVERY listed
   * namespace, and claim/heartbeat only ever touch those namespaces.
   */
  namespaces: readonly Namespace[];
  tasks: TaskManifest[];
}

/**
 * Register a worker process: insert the workers row, upsert its task
 * definitions and sync schedules — one transaction, per namespace. Returns the
 * new worker id.
 */
export async function registerWorker(
  pool: Pool,
  args: RegisterWorkerArgs,
): Promise<{ workerId: string }> {
  if (!Array.isArray(args.tasks)) {
    throw new KernelError('bad_request', 'tasks must be an array');
  }
  if (!Array.isArray(args.namespaces) || args.namespaces.length === 0) {
    throw new KernelError('bad_request', 'namespaces must be a non-empty array');
  }
  for (const ns of args.namespaces) assertNamespace(ns);
  for (const t of args.tasks) {
    if (typeof t?.id !== 'string' || t.id.length === 0) {
      throw new KernelError('bad_request', 'task.id must be a non-empty string');
    }
  }
  const id = genWorkerId();
  // What this process serves, as (task id, code version) pairs. It used to be a
  // bare array of ids; the pairs are what the stranded-run scan needs to answer
  // "is any online worker still able to replay this run's ledger", and there is
  // nowhere else to read them from. Same jsonb column, so no migration — and
  // every reader normalizes both shapes, because an offline row written by an
  // older build (or a peer mid-rollout) still holds the string form.
  const taskEntries = args.tasks.map((t) => ({
    id: t.id,
    codeVersion: t.codeVersion ?? args.codeVersion,
  }));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert worker row. The namespaces column is the worker's claim scope;
    // tasks/schedules are upserted per namespace below.
    await client.query(
      `INSERT INTO workers
         (id, name, code_version, runtime, tasks, namespaces, concurrency, started_at, last_heartbeat_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now(), 'online')`,
      [
        id,
        args.name ?? null,
        args.codeVersion,
        args.runtime,
        JSON.stringify(taskEntries),
        JSON.stringify(args.namespaces),
        args.concurrency,
      ],
    );

    // Upsert each task definition in every namespace this worker serves — a
    // staging worker registering the same task id must not touch the prod task
    // row, and vice versa (C2).
    for (const ns of args.namespaces) {
      for (const t of args.tasks) {
        await upsertTask(client, t, t.codeVersion ?? args.codeVersion, ns);
      }
      // Sync schedules: upsert cron tasks (preserve enabled), delete others.
      await syncSchedules(client, args.tasks, ns);
    }

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

/**
 * `codeVersion` here is the TASK's version (manifest first, worker-level only
 * as the fallback for a manifest that carries none). It lands on
 * tasks.latest_code_version, which is what every new run of the task is stamped
 * with — so an edit to one task must not move the version of the runs of
 * another, or version-pinned claims would strand runs nobody touched.
 */
async function upsertTask(
  client: PoolClient,
  t: TaskManifest,
  codeVersion: string,
  namespace: Namespace,
): Promise<void> {
  const triggerSource = t.cron ? 'schedule' : 'api';
  await client.query(
    `INSERT INTO tasks
       (id, project_id, env, name, file_path, trigger_source, cron_pattern, cron_tz, retry,
        concurrency_limit, latest_code_version, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
     ON CONFLICT (project_id, env, id) DO UPDATE
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
      namespace.projectId,
      namespace.env,
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
  namespace: Namespace,
): Promise<void> {
  const cronTaskIds: string[] = [];
  for (const t of tasks) {
    if (!t.cron) continue;
    cronTaskIds.push(t.id);
    const next = nextCronAt(t.cron.pattern, t.cron.timezone);
    // Upsert by (project_id, env, task_id) (unique), preserving existing
    // enabled flag — the namespace is part of the key, so one namespace's sync
    // can never touch another's schedule rows (C2).
    await client.query(
      `INSERT INTO schedules
         (id, project_id, env, task_id, cron_pattern, cron_tz, enabled, next_run_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, true, $7, now(), now())
       ON CONFLICT (project_id, env, task_id) DO UPDATE
         SET cron_pattern = EXCLUDED.cron_pattern,
             cron_tz = EXCLUDED.cron_tz,
             next_run_at = CASE WHEN schedules.enabled THEN EXCLUDED.next_run_at ELSE NULL END,
             updated_at = now()`,
      [
        genScheduleId(),
        namespace.projectId,
        namespace.env,
        t.id,
        t.cron.pattern,
        t.cron.timezone ?? null,
        next,
      ],
    );
  }

  // Remove schedules for tasks this manifest no longer declares as cron.
  // Only prune schedules whose task appears in the manifest but lost its cron,
  // plus any schedule for tasks in the manifest that are not cron now. Scoped
  // to the namespace: a worker re-registering in one namespace must never
  // delete another namespace's schedules for the same task ids (C2).
  const manifestTaskIds = tasks.map((t) => t.id);
  if (manifestTaskIds.length > 0) {
    await client.query(
      `DELETE FROM schedules
        WHERE project_id = $1 AND env = $2
          AND task_id = ANY($3::text[]) AND task_id <> ALL($4::text[])`,
      [
        namespace.projectId,
        namespace.env,
        manifestTaskIds,
        cronTaskIds.length > 0 ? cronTaskIds : [''],
      ],
    );
  }
}
