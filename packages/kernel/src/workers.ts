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
import type { KernelLogger } from './kernel';
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
  /**
   * Sink for registration warnings (todos/01-correctness.md C4): a task
   * metadata update refused because a different code version is already
   * registered and still served. Defaults to console.
   */
  logger?: KernelLogger;
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
  const logger: KernelLogger = args.logger ?? console;
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
    //
    // C4: upsertTask returns whether THIS worker became the task's metadata
    // owner (first registration, same-version refresh, or takeover of an
    // unserved version). Only the owner may sync that task's schedule — a
    // rejected (non-owner) registration must not rewrite the cron pattern the
    // owner registered, push a due fire into the future, or delete the
    // owner's schedule because this older manifest dropped the cron.
    for (const ns of args.namespaces) {
      const ownerTasks: TaskManifest[] = [];
      for (const t of args.tasks) {
        const owner = await upsertTask(client, t, t.codeVersion ?? args.codeVersion, ns, logger);
        if (owner) ownerTasks.push(t);
      }
      // Sync schedules of OWNED tasks only (preserve enabled), delete others'.
      await syncSchedules(client, ownerTasks, ns);
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
 *
 * C4 owner/version rule (todos/01-correctness.md): the metadata row belongs to
 * the FIRST version that claims it and is still being served, so a restarting
 * OLD worker can never roll a NEW worker's metadata back (last-writer-wins
 * did exactly that in a rolling deploy). The conflict update is guarded:
 *
 *   1. stored latest_code_version IS NULL          — first registration wins
 *   2. incoming == stored                          — same build re-registering:
 *                                                    idempotent metadata refresh
 *   3. incoming != stored AND no online worker is  — the stored version's
 *      serving the STORED version for this task      workers are gone (deploy
 *      in this namespace                            finished, or rolled back):
 *                                                    takeover is safe
 *
 * otherwise (different version whose workers are still alive) the update is
 * skipped and a warn is logged. Registration timestamps cannot order the two
 * cases — an old worker restarting and a new worker deploying both register
 * "now" — so "still served" is the only signal that separates them. The
 * subquery looks up the STORED version (tasks.latest_code_version, built into
 * the jsonb pair with jsonb_build_object) — never the incoming one, which the
 * registering worker's own row (inserted earlier in this same transaction,
 * online with a fresh heartbeat) would otherwise always match and block every
 * takeover. A stored version is "served" by a workers row that is online,
 * heartbeating within the same 2-minute window the offline marker uses
 * (orchestrator.ts WORKER_OFFLINE_MS), serves this namespace (C2) and lists
 * this (task id, stored version) pair. The guard lives in the upsert itself
 * (one atomic statement, no check-then-write race); a refused update comes
 * back as rowCount 0 and the caller is NOT the metadata owner (see
 * registerWorker — only the owner syncs that task's schedule).
 */
async function upsertTask(
  client: PoolClient,
  t: TaskManifest,
  codeVersion: string,
  namespace: Namespace,
  logger: KernelLogger,
): Promise<boolean> {
  const triggerSource = t.cron ? 'schedule' : 'api';
  const res = await client.query(
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
           updated_at = now()
     WHERE tasks.latest_code_version IS NULL
        OR tasks.latest_code_version = EXCLUDED.latest_code_version
        OR NOT EXISTS (
          SELECT 1 FROM workers w
           WHERE w.status = 'online'
             AND w.last_heartbeat_at > now() - INTERVAL '2 minutes'
             AND w.namespaces @> $12::jsonb
             AND w.tasks @> jsonb_build_array(
                   jsonb_build_object('id', tasks.id, 'codeVersion', tasks.latest_code_version)
                 )
        )`,
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
      // $12: this namespace — the (task id, stored version) pair the subquery
      // matches is built in SQL from the target row, not bound from the
      // incoming manifest (which would match the registering worker's own row).
      JSON.stringify([namespace]),
    ],
  );
  if (res.rowCount === 0) {
    // The guard refused the overwrite: the stored version is different AND
    // still served. Name it (one indexed read on a rare path) so the log says
    // which build owns the metadata instead of only that ours lost.
    const stored = await client.query<{ latest_code_version: string | null }>(
      `SELECT latest_code_version FROM tasks
        WHERE project_id = $1 AND env = $2 AND id = $3`,
      [namespace.projectId, namespace.env, t.id],
    );
    logger.warn(
      `[registration] task ${t.id} in ${namespace.projectId}/${namespace.env}: ` +
        `code version ${codeVersion} NOT applied — ` +
        `${stored.rows[0]?.latest_code_version ?? '(none)'} is already registered ` +
        `and still served by an online worker; keeping the live version`,
    );
    return false;
  }
  return true;
}

/**
 * Upsert cron schedules for the OWNED tasks of this registration and remove
 * schedules for owned tasks that lost their cron — see registerWorker: the
 * caller only passes tasks whose metadata upsert succeeded (owner), so a
 * non-owner registration can never rewrite or delete another version's
 * schedule (C4).
 *
 * next_run_at is only recomputed when the schedule actually CHANGED — the
 * pattern or the timezone. last-writer-wins recomputed it on every
 * registration, so a worker restarting during a rolling deploy pushed an
 * already-due schedule's fire into the future and silently skipped it. Same
 * pattern + timezone ⇒ the existing next_run_at is kept verbatim (a due
 * schedule stays due); a fresh INSERT still computes it normally. There is
 * deliberately NO disabled→enabled branch here: this statement never changes
 * `enabled` (the INSERT binds true, the SET does not mention it), so the only
 * disabled→enabled transition is the dashboard PATCH, which recomputes
 * next_run_at itself — and a disabled row's NULL next_run_at must survive a
 * registration with the same pattern, not be refilled.
 */
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
             next_run_at = CASE
               WHEN schedules.cron_pattern IS DISTINCT FROM EXCLUDED.cron_pattern
                 OR schedules.cron_tz IS DISTINCT FROM EXCLUDED.cron_tz
               THEN EXCLUDED.next_run_at
               ELSE schedules.next_run_at
             END,
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
