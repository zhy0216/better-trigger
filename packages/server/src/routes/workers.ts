/* =============================================================================
   @better-trigger/server — worker protocol routes.
   POST /workers/register  · POST /workers/:id/heartbeat · GET /dequeue
   register upserts tasks + schedules (cron sync). dequeue long-polls.
   See docs/backend-contract.md §3.5, §3.6, §4.
   ============================================================================= */
import { Hono } from 'hono';
import type { PoolClient } from 'pg';
import type {
  DequeueResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  RegisterWorkerRequest,
  RegisterWorkerResponse,
  TaskManifest,
} from '@better-trigger/core';
import { pool } from '../db/index';
import { workerId as genWorkerId, scheduleId as genScheduleId } from '../ids';
import { dequeueOne, renewLocks } from '../engine/queue';
import { nextCronAt } from '../engine/orchestrator';
import { assertArray, assertString } from '../validate';

const HEARTBEAT_INTERVAL_MS = 15_000;
const VISIBILITY_TIMEOUT_MS = 60_000;
const DEQUEUE_DEFAULT_TIMEOUT_MS = 20_000;
const DEQUEUE_MAX_TIMEOUT_MS = 30_000;
const DEQUEUE_POLL_MS = 500;

/** Sleep that resolves early when the request is aborted (client gone). */
const sleepAbortable = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

/**
 * Has the long-poll client gone away? Checks both the fetch AbortSignal and
 * the underlying node socket state (@hono/node-server exposes
 * env.incoming/env.outgoing) — the signal alone does not fire on socket close
 * under every runtime (e.g. bun's node:http compat).
 */
function clientGone(signal: AbortSignal, env: unknown): boolean {
  if (signal.aborted) return true;
  const e = env as
    | {
        incoming?: { destroyed?: boolean; socket?: { destroyed?: boolean } };
        outgoing?: { destroyed?: boolean; writableEnded?: boolean };
      }
    | undefined;
  return Boolean(
    e?.outgoing?.destroyed || e?.incoming?.destroyed || e?.incoming?.socket?.destroyed,
  );
}

export function workerRoutes(): Hono {
  const app = new Hono();

  /* --------------------------------------------------------- register */
  app.post('/workers/register', async (c) => {
    const body = await c.req.json<RegisterWorkerRequest>();
    assertArray(body.tasks, 'tasks');
    for (const t of body.tasks) {
      assertString((t as TaskManifest)?.id, 'task.id');
    }
    const id = genWorkerId();
    const taskIds = body.tasks.map((t) => t.id);

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
          body.name ?? null,
          body.codeVersion,
          body.runtime,
          JSON.stringify(taskIds),
          body.concurrency,
        ],
      );

      // Upsert each task definition.
      for (const t of body.tasks) {
        await upsertTask(client, t, body.codeVersion);
      }

      // Sync schedules: upsert cron tasks (preserve enabled), delete others.
      await syncSchedules(client, body.tasks);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const res: RegisterWorkerResponse = {
      workerId: id,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      visibilityTimeoutMs: VISIBILITY_TIMEOUT_MS,
    };
    return c.json(res);
  });

  /* -------------------------------------------------------- heartbeat */
  app.post('/workers/:id/heartbeat', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<HeartbeatRequest>();
    const cancelRunIds = await renewLocks(id, body.runIds ?? []);
    const res: HeartbeatResponse = { ok: true, cancelRunIds };
    return c.json(res);
  });

  /* ---------------------------------------------------------- dequeue */
  app.get('/dequeue', async (c) => {
    const workerIdValue = c.req.query('workerId');
    if (!workerIdValue) {
      return c.json({ error: { code: 'bad_request', message: 'workerId required' } }, 400);
    }
    const rawTimeout = Number(c.req.query('timeoutMs') ?? DEQUEUE_DEFAULT_TIMEOUT_MS);
    const timeoutMs = Math.min(
      Number.isFinite(rawTimeout) ? rawTimeout : DEQUEUE_DEFAULT_TIMEOUT_MS,
      DEQUEUE_MAX_TIMEOUT_MS,
    );

    // Resolve the worker's registered task list.
    const wkr = await pool.query<{ tasks: string[] }>(
      `SELECT tasks FROM workers WHERE id = $1`,
      [workerIdValue],
    );
    const taskIds = (wkr.rows[0]?.tasks as string[] | undefined) ?? [];

    const deadline = Date.now() + timeoutMs;
    const signal = c.req.raw.signal;
    // Long poll: try, then poll every 500ms until the deadline. Stop as soon
    // as the client disconnects — otherwise a dead worker's in-flight poll
    // would lock a run nobody will execute (stalling it until the reaper).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (clientGone(signal, c.env)) break;
      const run = await dequeueOne(workerIdValue, taskIds);
      if (run) {
        const res: DequeueResponse = { run };
        return c.json(res);
      }
      if (Date.now() + DEQUEUE_POLL_MS >= deadline) break;
      await sleepAbortable(DEQUEUE_POLL_MS, signal);
    }
    const res: DequeueResponse = { run: null };
    return c.json(res);
  });

  return app;
}

/* ---------------------------------------------------------------------------
 * Task + schedule upsert helpers (exported for trigger route reuse if needed)
 * ------------------------------------------------------------------------- */

export async function upsertTask(
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

export async function syncSchedules(
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
