/* =============================================================================
   @better-trigger/server — run lifecycle engine.
   Create (idempotent) / steps / suspend / wait-for-run / batch-trigger /
   complete / fail / cancel / retry, plus parent-wakeup for child runs.
   See docs/backend-contract.md §3.2–3.7. All multi-row mutations are wrapped
   in a single transaction via withTx().
   ============================================================================= */
import type { PoolClient } from 'pg';
import {
  computeBackoffMs,
  parseDuration,
  resolveRetryPolicy,
  type RetryPolicy,
  type SerializedError,
  type StepKind,
  type TriggerOptions,
  type TriggerType,
} from '@better-trigger/core';
import { pool } from '../db/index';
import { runId as genRunId } from '../ids';
import { enqueue, removeFromQueue } from './queue';

/** Upper bound for a delay before a run becomes available: 10 years in ms. */
const MAX_DELAY_MS = 315_576_000_000;

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */

export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RunRow {
  id: string;
  task_id: string;
  status: string;
  attempt: number;
  max_attempts: number;
  parent_run_id: string | null;
  payload: unknown;
  env: string;
  concurrency_key: string | null;
  code_version: string | null;
}

async function getRun(
  client: PoolClient | typeof pool,
  id: string,
): Promise<RunRow | null> {
  const res = await client.query<RunRow>(
    `SELECT id, task_id, status, attempt, max_attempts, parent_run_id,
            payload, env, concurrency_key, code_version
       FROM runs WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/**
 * Assert a worker may report on this run: the run must be 'running' and the
 * queue row must be locked by this worker. Throws 409 run_not_running otherwise.
 */
async function assertRunningOwnedBy(
  client: PoolClient,
  runId: string,
  workerId: string,
): Promise<RunRow> {
  const run = await getRun(client, runId);
  if (!run) throw new HttpError(404, 'not_found', `run ${runId} not found`);
  if (run.status !== 'running') {
    throw new HttpError(409, 'run_not_running', `run ${runId} is ${run.status}`);
  }
  const lock = await client.query<{ locked_by: string | null }>(
    `SELECT locked_by FROM queue WHERE run_id = $1`,
    [runId],
  );
  if (lock.rows[0]?.locked_by !== workerId) {
    throw new HttpError(409, 'run_not_running', `run ${runId} not locked by worker`);
  }
  return run;
}

/* ---------------------------------------------------------------------------
 * Create run (with idempotency)
 * ------------------------------------------------------------------------- */

export interface CreateRunArgs {
  taskId: string;
  payload: unknown;
  options?: TriggerOptions;
  triggerType: TriggerType;
  parentRunId?: string | null;
  /** Defaults to task.retry policy. */
  retry?: RetryPolicy;
  env?: string;
  client?: PoolClient;
  /** Require the task to exist (trigger API). */
  requireTask?: boolean;
}

export interface CreatedRun {
  runId: string;
  idempotent: boolean;
}

/**
 * Create a run + enqueue it. If options.idempotencyKey matches an existing run
 * for the same task, the existing run id is returned with idempotent=true.
 */
export async function createRun(args: CreateRunArgs): Promise<CreatedRun> {
  const run = (c: PoolClient) => createRunIn(c, args);
  if (args.client) return run(args.client);
  return withTx(run);
}

async function createRunIn(
  client: PoolClient,
  args: CreateRunArgs,
): Promise<CreatedRun> {
  const opts = args.options ?? {};

  // Validate priority up front (covers trigger / batch-trigger / wait-for-run /
  // retry — all funnel through here). Must be an int32 to fit queue.priority int4.
  if (opts.priority != null) {
    if (
      typeof opts.priority !== 'number' ||
      !Number.isSafeInteger(opts.priority) ||
      opts.priority < -2147483648 ||
      opts.priority > 2147483647
    ) {
      throw new HttpError(400, 'bad_request', 'priority must be an int32');
    }
  }

  // Resolve task config (retry policy, concurrency limit/key default).
  const taskRes = await client.query<{
    id: string;
    retry: RetryPolicy | null;
    concurrency_limit: number | null;
  }>(`SELECT id, retry, concurrency_limit FROM tasks WHERE id = $1`, [args.taskId]);
  const task = taskRes.rows[0];
  if (!task && args.requireTask) {
    throw new HttpError(404, 'not_found', `task ${args.taskId} not registered`);
  }

  const policy = resolveRetryPolicy(args.retry ?? task?.retry ?? undefined);
  const hasLimit = (task?.concurrency_limit ?? 0) > 0;
  const concurrencyKey = hasLimit
    ? opts.concurrencyKey ?? args.taskId
    : opts.concurrencyKey ?? null;
  const env = opts.env ?? args.env ?? 'prod';

  const delayMs = opts.delay != null ? parseDuration(opts.delay) : 0;
  if (delayMs > MAX_DELAY_MS) {
    throw new HttpError(400, 'bad_request', 'delay exceeds maximum of 10 years');
  }
  const availableAt = new Date(Date.now() + delayMs);
  if (Number.isNaN(availableAt.getTime())) {
    throw new HttpError(400, 'bad_request', 'delay produces an invalid date');
  }

  const id = genRunId();

  // Idempotency is enforced atomically by the partial unique index
  // (task_id, idempotency_key) WHERE idempotency_key IS NOT NULL. INSERT ...
  // ON CONFLICT DO NOTHING wins the race; a loser gets no row back and reads the
  // existing run. (Without a key there is no conflict target, so insert plainly.)
  const insertSql = opts.idempotencyKey
    ? `INSERT INTO runs
         (id, task_id, status, payload, trigger_type, parent_run_id,
          idempotency_key, concurrency_key, attempt, max_attempts, env, queued_at, created_at, updated_at)
       VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,1,$8,$9, now(), now(), now())
       ON CONFLICT (task_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`
    : `INSERT INTO runs
         (id, task_id, status, payload, trigger_type, parent_run_id,
          idempotency_key, concurrency_key, attempt, max_attempts, env, queued_at, created_at, updated_at)
       VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,1,$8,$9, now(), now(), now())
       RETURNING id`;
  const inserted = await client.query<{ id: string }>(insertSql, [
    id,
    args.taskId,
    JSON.stringify(args.payload ?? null),
    args.triggerType,
    args.parentRunId ?? null,
    opts.idempotencyKey ?? null,
    concurrencyKey,
    policy.maxAttempts,
    env,
  ]);

  // No row returned ⇒ idempotency conflict: return the pre-existing run and do
  // NOT enqueue (the original trigger already did).
  if (inserted.rows.length === 0) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM runs WHERE task_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [args.taskId, opts.idempotencyKey],
    );
    if (existing.rows[0]) {
      return { runId: existing.rows[0].id, idempotent: true };
    }
    // Defensive: a DO NOTHING with no surviving row should not happen.
    throw new HttpError(500, 'internal_error', 'failed to create run');
  }

  await enqueue({
    client,
    runId: id,
    availableAt,
    priority: opts.priority ?? 0,
    concurrencyKey,
    env,
  });

  return { runId: id, idempotent: false };
}

/* ---------------------------------------------------------------------------
 * Steps (memoized step rows)
 * ------------------------------------------------------------------------- */

export interface ReportStepArgs {
  runId: string;
  seq: number;
  kind: StepKind;
  label?: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: SerializedError;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  workerId: string;
}

export async function reportStep(args: ReportStepArgs): Promise<void> {
  await withTx(async (client) => {
    await assertRunningOwnedBy(client, args.runId, args.workerId);
    await upsertStep(client, args);
  });
}

async function upsertStep(client: PoolClient, args: ReportStepArgs): Promise<void> {
  await client.query(
    `INSERT INTO run_steps
       (run_id, seq, kind, label, status, output, error, attempt, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (run_id, seq) DO UPDATE
       SET kind = EXCLUDED.kind,
           label = EXCLUDED.label,
           status = EXCLUDED.status,
           output = EXCLUDED.output,
           error = EXCLUDED.error,
           attempt = EXCLUDED.attempt,
           started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at`,
    [
      args.runId,
      args.seq,
      args.kind,
      args.label ?? null,
      args.status,
      args.output !== undefined ? JSON.stringify(args.output) : null,
      args.error !== undefined ? JSON.stringify(args.error) : null,
      args.attempt,
      args.startedAt,
      args.finishedAt,
    ],
  );
}

/* ---------------------------------------------------------------------------
 * Suspend (wait.for / wait.until)
 * ------------------------------------------------------------------------- */

export interface SuspendArgs {
  runId: string;
  seq: number;
  label?: string;
  kind: 'duration' | 'until';
  resumeAt: string;
  workerId: string;
}

/**
 * If resumeAt is already past, synchronously complete the wait (write the step
 * row) and keep the run running with its queue lock held → { resumed: true }.
 * Otherwise insert a pending wait, flip the run to 'waiting' and drop the
 * queue row → { resumed: false }.
 */
export async function suspend(args: SuspendArgs): Promise<{ resumed: boolean }> {
  return withTx(async (client) => {
    await assertRunningOwnedBy(client, args.runId, args.workerId);
    const resumeAt = new Date(args.resumeAt);

    if (resumeAt.getTime() <= Date.now()) {
      // Already due — record the wait step as completed, keep running.
      await upsertStep(client, {
        runId: args.runId,
        seq: args.seq,
        kind: 'wait',
        label: args.label,
        status: 'completed',
        output: null,
        attempt: 1,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        workerId: args.workerId,
      });
      return { resumed: true };
    }

    await client.query(
      `INSERT INTO waits (run_id, step_seq, kind, resume_at, status, created_at)
       VALUES ($1,$2,$3,$4,'pending', now())`,
      [args.runId, args.seq, args.kind, resumeAt],
    );
    await client.query(
      `UPDATE runs SET status = 'waiting', updated_at = now() WHERE id = $1`,
      [args.runId],
    );
    await removeFromQueue(args.runId, client);
    return { resumed: false };
  });
}

/* ---------------------------------------------------------------------------
 * triggerAndWait (wait-for-run)
 * ------------------------------------------------------------------------- */

export interface WaitForRunArgs {
  runId: string;
  seq: number;
  label?: string;
  taskId: string;
  payload: unknown;
  options?: TriggerOptions;
  workerId: string;
}

export async function waitForRun(args: WaitForRunArgs): Promise<{ childRunId: string }> {
  return withTx(async (client) => {
    const parent = await assertRunningOwnedBy(client, args.runId, args.workerId);

    // Idempotent on replay: a completed wait step at this seq means the child
    // already ran; the SDK should normally hit the snapshot, but guard anyway.
    const existingStep = await client.query<{ output: unknown }>(
      `SELECT output FROM run_steps WHERE run_id = $1 AND seq = $2 AND status = 'completed'`,
      [args.runId, args.seq],
    );
    if (existingStep.rows[0]) {
      const out = existingStep.rows[0].output as { id?: string } | null;
      if (out?.id) return { childRunId: out.id };
    }
    // Or a pending wait already created the child.
    const existingWait = await client.query<{ child_run_id: string | null }>(
      `SELECT child_run_id FROM waits
        WHERE run_id = $1 AND step_seq = $2 AND kind = 'run' AND status = 'pending'`,
      [args.runId, args.seq],
    );
    if (existingWait.rows[0]?.child_run_id) {
      return { childRunId: existingWait.rows[0].child_run_id };
    }

    const child = await createRunIn(client, {
      taskId: args.taskId,
      payload: args.payload,
      options: args.options,
      triggerType: 'subtask',
      parentRunId: args.runId,
      env: parent.env,
    });

    await client.query(
      `INSERT INTO waits (run_id, step_seq, kind, child_run_id, status, created_at)
       VALUES ($1,$2,'run',$3,'pending', now())`,
      [args.runId, args.seq, child.runId],
    );
    await client.query(
      `UPDATE runs SET status = 'waiting', updated_at = now() WHERE id = $1`,
      [args.runId],
    );
    await removeFromQueue(args.runId, client);

    return { childRunId: child.runId };
  });
}

/* ---------------------------------------------------------------------------
 * batchTrigger (durable step)
 * ------------------------------------------------------------------------- */

export interface BatchTriggerStepArgs {
  runId: string;
  seq: number;
  label?: string;
  items: { taskId: string; payload: unknown; options?: TriggerOptions }[];
  workerId: string;
}

export async function batchTriggerStep(
  args: BatchTriggerStepArgs,
): Promise<{ runIds: string[] }> {
  return withTx(async (client) => {
    const parent = await assertRunningOwnedBy(client, args.runId, args.workerId);

    // Idempotent: if the step row already exists, return its recorded runIds.
    const existing = await client.query<{ output: unknown }>(
      `SELECT output FROM run_steps WHERE run_id = $1 AND seq = $2`,
      [args.runId, args.seq],
    );
    if (existing.rows[0]) {
      const out = existing.rows[0].output as { runIds?: string[] } | null;
      if (out?.runIds) return { runIds: out.runIds };
    }

    const runIds: string[] = [];
    for (const item of args.items) {
      const child = await createRunIn(client, {
        taskId: item.taskId,
        payload: item.payload,
        options: item.options,
        triggerType: 'subtask',
        parentRunId: args.runId,
        env: parent.env,
      });
      runIds.push(child.runId);
    }

    await upsertStep(client, {
      runId: args.runId,
      seq: args.seq,
      kind: 'batch-trigger',
      label: args.label,
      status: 'completed',
      output: { runIds },
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workerId: args.workerId,
    });

    return { runIds };
  });
}

/* ---------------------------------------------------------------------------
 * Terminal transitions: complete / fail / cancel, with parent wakeup
 * ------------------------------------------------------------------------- */

/**
 * If `childRunId` is awaited by a pending 'run' wait, fill the parent step row
 * with { id, ok, output?, error? } and re-enqueue the parent. Runs inside the
 * caller's transaction.
 */
async function wakeParentIfWaiting(
  client: PoolClient,
  childRunId: string,
  result: { ok: boolean; output?: unknown; error?: SerializedError },
): Promise<void> {
  const waitRes = await client.query<{
    id: number;
    run_id: string;
    step_seq: number;
  }>(
    `SELECT id, run_id, step_seq FROM waits
      WHERE child_run_id = $1 AND kind = 'run' AND status = 'pending'
      FOR UPDATE`,
    [childRunId],
  );
  const wait = waitRes.rows[0];
  if (!wait) return;

  await client.query(`UPDATE waits SET status = 'completed' WHERE id = $1`, [wait.id]);

  const stepOutput: { id: string; ok: boolean; output?: unknown; error?: SerializedError } =
    { id: childRunId, ok: result.ok };
  if (result.output !== undefined) stepOutput.output = result.output;
  if (result.error !== undefined) stepOutput.error = result.error;

  await client.query(
    `INSERT INTO run_steps
       (run_id, seq, kind, label, status, output, error, attempt, started_at, finished_at)
     VALUES ($1,$2,'trigger-and-wait',NULL,'completed',$3,NULL,1, now(), now())
     ON CONFLICT (run_id, seq) DO UPDATE
       SET status = 'completed', output = EXCLUDED.output, finished_at = now()`,
    [wait.run_id, wait.step_seq, JSON.stringify(stepOutput)],
  );

  // Re-enqueue the parent.
  const parent = await getRun(client, wait.run_id);
  if (parent && parent.status === 'waiting') {
    await client.query(
      `UPDATE runs SET status = 'queued', updated_at = now() WHERE id = $1`,
      [wait.run_id],
    );
    await enqueue({
      client,
      runId: wait.run_id,
      availableAt: new Date(),
      concurrencyKey: parent.concurrency_key,
      env: parent.env,
    });
  }
}

export interface CompleteArgs {
  runId: string;
  output: unknown;
  workerId: string;
}

export async function completeRun(args: CompleteArgs): Promise<void> {
  await withTx(async (client) => {
    const run = await assertRunningOwnedBy(client, args.runId, args.workerId);
    await client.query(
      `UPDATE runs
          SET status = 'completed', output = $2, finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [args.runId, JSON.stringify(args.output ?? null)],
    );
    await removeFromQueue(args.runId, client);
    if (run.parent_run_id) {
      await wakeParentIfWaiting(client, args.runId, { ok: true, output: args.output });
    }
  });
}

export interface FailArgs {
  runId: string;
  error: SerializedError;
  stepSeq?: number;
  retry?: RetryPolicy;
  abort?: boolean;
  workerId: string;
}

export interface FailResult {
  willRetry: boolean;
  nextAttemptAt?: string;
}

export async function failRun(args: FailArgs): Promise<FailResult> {
  return withTx(async (client) => {
    const run = await assertRunningOwnedBy(client, args.runId, args.workerId);
    const maxAttempts = args.retry?.maxAttempts ?? run.max_attempts;

    const willRetry = !args.abort && run.attempt < maxAttempts;

    if (!willRetry) {
      await client.query(
        `UPDATE runs
            SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
          WHERE id = $1`,
        [args.runId, JSON.stringify(args.error)],
      );
      await removeFromQueue(args.runId, client);
      if (run.parent_run_id) {
        await wakeParentIfWaiting(client, args.runId, { ok: false, error: args.error });
      }
      return { willRetry: false };
    }

    const backoff = computeBackoffMs(run.attempt, args.retry);
    const nextAt = new Date(Date.now() + backoff);
    await client.query(
      `UPDATE runs
          SET status = 'queued', attempt = attempt + 1, error = $2, updated_at = now()
        WHERE id = $1`,
      [args.runId, JSON.stringify(args.error)],
    );
    // Keep the queue row but unlock it and push availability out.
    await client.query(
      `UPDATE queue SET locked_by = NULL, locked_at = NULL, available_at = $2
        WHERE run_id = $1`,
      [args.runId, nextAt],
    );
    return { willRetry: true, nextAttemptAt: nextAt.toISOString() };
  });
}

export async function cancelRun(runId: string): Promise<void> {
  await withTx(async (client) => {
    const run = await getRun(client, runId);
    if (!run) throw new HttpError(404, 'not_found', `run ${runId} not found`);
    if (['completed', 'failed', 'canceled'].includes(run.status)) {
      // Already terminal — treat cancel as a no-op success.
      return;
    }
    await client.query(
      `UPDATE runs SET status = 'canceled', finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [runId],
    );
    await removeFromQueue(runId, client);
    await client.query(
      `UPDATE waits SET status = 'canceled' WHERE run_id = $1 AND status = 'pending'`,
      [runId],
    );
    if (run.parent_run_id) {
      await wakeParentIfWaiting(client, runId, {
        ok: false,
        error: { message: 'child canceled' },
      });
    }
  });
}

export async function retryRun(runId: string): Promise<{ runId: string }> {
  return withTx(async (client) => {
    const run = await getRun(client, runId);
    if (!run) throw new HttpError(404, 'not_found', `run ${runId} not found`);
    if (!['failed', 'canceled'].includes(run.status)) {
      throw new HttpError(400, 'invalid_state', `run ${runId} is ${run.status}, not retryable`);
    }
    const created = await createRunIn(client, {
      taskId: run.task_id,
      payload: run.payload,
      triggerType: 'retry',
      env: run.env,
    });
    return { runId: created.runId };
  });
}

/* ---------------------------------------------------------------------------
 * Logs (best effort, any run status)
 * ------------------------------------------------------------------------- */

export interface IncomingLog {
  ts: string;
  level: string;
  message: string;
  data?: unknown;
  stepSeq?: number;
}

/** Rows per INSERT. 6 bind params each → 6000 params, well under pg's 65535. */
const LOG_INSERT_CHUNK = 1000;

export async function appendLogs(runId: string, entries: IncomingLog[]): Promise<void> {
  if (entries.length === 0) return;
  const run = await getRun(pool, runId);
  if (!run) throw new HttpError(404, 'not_found', `run ${runId} not found`);

  // Chunk inserts so a single request can never exceed pg's 65535 bind-param
  // limit (6 params/row → cap at LOG_INSERT_CHUNK rows per statement).
  for (let start = 0; start < entries.length; start += LOG_INSERT_CHUNK) {
    const chunk = entries.slice(start, start + LOG_INSERT_CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const e of chunk) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(
        runId,
        e.stepSeq ?? null,
        e.level,
        e.message,
        e.data !== undefined ? JSON.stringify(e.data) : null,
        e.ts,
      );
    }
    await pool.query(
      `INSERT INTO logs (run_id, step_seq, level, message, data, ts) VALUES ${values.join(',')}`,
      params,
    );
  }
}
