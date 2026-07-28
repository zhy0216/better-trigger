/* =============================================================================
   @better-trigger/core — kernel run lifecycle.
   Create (idempotent) / steps / suspend / wait-for-child / batch-trigger /
   complete / fail / cancel / retry, plus parent-wakeup for child runs, run
   reads (getRun / getRunDetail / waitForResult) and best-effort logs.
   See docs/backend-contract.md §3.2–3.7. All multi-row mutations are wrapped
   in a single transaction via withTx(). Worker-side writes are guarded by the
   fencing check (locked_by + fencing_token under FOR UPDATE) — lease_until is
   deliberately NOT part of validity: an expired-but-unreclaimed owner is still
   the only owner, so its writes stay legal until the reaper or a new claim
   invalidates the token.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { computeBackoffMs, resolveRetryPolicy } from '../backoff';
import { parseDuration } from '../duration';
import type {
  LogEntry,
  LogLevel,
  RetryPolicy,
  RunStatus,
  SerializedError,
  StepKind,
  StepStatus,
  TriggerItem,
  TriggerOptions,
  TriggerType,
  WaitKind,
} from '../types';
import { KernelError, RunNotRunningError, StaleLeaseError, TaskNotFoundError } from './errors';
import { runId as genRunId } from './ids';
import { enqueue, removeFromQueue } from './queue';

/** Upper bound for a delay before a run becomes available: 10 years in ms. */
const MAX_DELAY_MS = 315_576_000_000;

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */

export async function withTx<T>(
  pool: Pool,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
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

export interface RunRow {
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

export async function getRunRow(
  db: Pool | PoolClient,
  id: string,
): Promise<RunRow | null> {
  const res = await db.query<RunRow>(
    `SELECT id, task_id, status, attempt, max_attempts, parent_run_id,
            payload, env, concurrency_key, code_version
       FROM runs WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/**
 * Fencing check — assert a worker may report on this run: lock the queue row
 * (FOR UPDATE serializes against claims and the reaper), then require the run
 * to be 'running' and the row to carry this worker's id + fencing token.
 * lease_until is NOT checked (see file header). Run in non-running state →
 * RunNotRunningError; owner/token mismatch → StaleLeaseError.
 */
async function assertOwnedRunning(
  client: PoolClient,
  runId: string,
  workerId: string,
  fencingToken: number,
): Promise<RunRow> {
  const lock = await client.query<{ locked_by: string | null; fencing_token: string }>(
    `SELECT locked_by, fencing_token FROM queue WHERE run_id = $1 FOR UPDATE`,
    [runId],
  );
  const run = await getRunRow(client, runId);
  if (!run) throw new KernelError('not_found', `run ${runId} not found`);
  if (run.status !== 'running') {
    throw new RunNotRunningError(`run ${runId} is ${run.status}`);
  }
  const owner = lock.rows[0];
  if (
    !owner ||
    owner.locked_by !== workerId ||
    Number(owner.fencing_token) !== fencingToken
  ) {
    throw new StaleLeaseError(`run ${runId} is not held by this worker (stale lease)`);
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
export async function createRun(pool: Pool, args: CreateRunArgs): Promise<CreatedRun> {
  return withTx(pool, (c) => createRunIn(c, args));
}

export async function createRunIn(
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
      throw new KernelError('bad_request', 'priority must be an int32');
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
    throw new TaskNotFoundError(`task ${args.taskId} not registered`);
  }

  const policy = resolveRetryPolicy(args.retry ?? task?.retry ?? undefined);
  const hasLimit = (task?.concurrency_limit ?? 0) > 0;
  const concurrencyKey = hasLimit
    ? opts.concurrencyKey ?? args.taskId
    : opts.concurrencyKey ?? null;
  const env = opts.env ?? args.env ?? 'prod';

  const delayMs = opts.delay != null ? parseDuration(opts.delay) : 0;
  if (delayMs > MAX_DELAY_MS) {
    throw new KernelError('bad_request', 'delay exceeds maximum of 10 years');
  }
  const availableAt = new Date(Date.now() + delayMs);
  if (Number.isNaN(availableAt.getTime())) {
    throw new KernelError('bad_request', 'delay produces an invalid date');
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
    throw new Error('failed to create run');
  }

  await enqueue(client, {
    runId: id,
    availableAt,
    priority: opts.priority ?? 0,
    concurrencyKey,
    env,
  });

  return { runId: id, idempotent: false };
}

/* ---------------------------------------------------------------------------
 * Client-side trigger / batchTrigger
 * ------------------------------------------------------------------------- */

export interface TriggerArgs {
  taskId: string;
  payload: unknown;
  options?: TriggerOptions;
}

/** Create one 'api' run for a registered task (TaskNotFoundError otherwise). */
export async function trigger(pool: Pool, args: TriggerArgs): Promise<CreatedRun> {
  if (typeof args.taskId !== 'string' || args.taskId.length === 0) {
    throw new KernelError('bad_request', 'taskId must be a non-empty string');
  }
  return createRun(pool, {
    taskId: args.taskId,
    payload: args.payload,
    options: args.options,
    triggerType: 'api',
    requireTask: true,
  });
}

/** Create N 'api' runs in one all-or-nothing transaction. */
export async function batchTrigger(
  pool: Pool,
  items: TriggerItem[],
): Promise<{ runIds: string[] }> {
  if (!Array.isArray(items)) {
    throw new KernelError('bad_request', 'items must be an array');
  }
  for (const item of items) {
    if (typeof item?.taskId !== 'string' || item.taskId.length === 0) {
      throw new KernelError('bad_request', 'item.taskId must be a non-empty string');
    }
  }
  const runIds = await withTx(pool, async (client) => {
    const ids: string[] = [];
    for (const item of items) {
      const created = await createRunIn(client, {
        taskId: item.taskId,
        payload: item.payload,
        options: item.options,
        triggerType: 'api',
        requireTask: true,
      });
      ids.push(created.runId);
    }
    return ids;
  });
  return { runIds };
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
  fencingToken: number;
}

/** Step-row payload without the fencing credentials. */
type StepWriteArgs = Omit<ReportStepArgs, 'workerId' | 'fencingToken'>;

export async function reportStep(pool: Pool, args: ReportStepArgs): Promise<void> {
  await withTx(pool, async (client) => {
    await assertOwnedRunning(client, args.runId, args.workerId, args.fencingToken);
    await upsertStep(client, args);
  });
}

async function upsertStep(client: PoolClient, args: StepWriteArgs): Promise<void> {
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

export interface SuspendRunArgs {
  runId: string;
  seq: number;
  label?: string;
  kind: 'duration' | 'until';
  resumeAt: string;
  workerId: string;
  fencingToken: number;
}

/**
 * If resumeAt is already past, synchronously complete the wait (write the step
 * row) and keep the run running with its claim held → { resumed: true }.
 * Otherwise insert a pending wait, flip the run to 'waiting' and drop the
 * queue row → { resumed: false }.
 */
export async function suspendRun(
  pool: Pool,
  args: SuspendRunArgs,
): Promise<{ resumed: boolean }> {
  return withTx(pool, async (client) => {
    await assertOwnedRunning(client, args.runId, args.workerId, args.fencingToken);
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
    await removeFromQueue(client, args.runId);
    return { resumed: false };
  });
}

/* ---------------------------------------------------------------------------
 * triggerAndWait (wait-for-child-run)
 * ------------------------------------------------------------------------- */

export interface WaitForChildRunArgs {
  runId: string;
  seq: number;
  label?: string;
  taskId: string;
  payload: unknown;
  options?: TriggerOptions;
  workerId: string;
  fencingToken: number;
}

export async function waitForChildRun(
  pool: Pool,
  args: WaitForChildRunArgs,
): Promise<{ childRunId: string }> {
  return withTx(pool, async (client) => {
    const parent = await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
    );

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
    await removeFromQueue(client, args.runId);

    return { childRunId: child.runId };
  });
}

/* ---------------------------------------------------------------------------
 * batchTrigger (durable step)
 * ------------------------------------------------------------------------- */

export interface BatchTriggerChildArgs {
  runId: string;
  seq: number;
  label?: string;
  items: TriggerItem[];
  workerId: string;
  fencingToken: number;
}

export async function batchTriggerChild(
  pool: Pool,
  args: BatchTriggerChildArgs,
): Promise<{ runIds: string[] }> {
  return withTx(pool, async (client) => {
    const parent = await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
    );

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
  const parent = await getRunRow(client, wait.run_id);
  if (parent && parent.status === 'waiting') {
    await client.query(
      `UPDATE runs SET status = 'queued', updated_at = now() WHERE id = $1`,
      [wait.run_id],
    );
    await enqueue(client, {
      runId: wait.run_id,
      availableAt: new Date(),
      concurrencyKey: parent.concurrency_key,
      env: parent.env,
    });
  }
}

/**
 * Shared terminal-failure wrap-up: flip the run to 'failed', drop its queue
 * row, cancel its pending waits and wake a waiting parent. Used by failRun's
 * no-retry branch and by the reaper's 'worker lost' path (so a child killed at
 * max attempts never leaves its parent waiting forever).
 */
export async function terminalFail(
  client: PoolClient,
  run: RunRow,
  error: SerializedError,
): Promise<void> {
  await client.query(
    `UPDATE runs
        SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [run.id, JSON.stringify(error)],
  );
  await removeFromQueue(client, run.id);
  await client.query(
    `UPDATE waits SET status = 'canceled' WHERE run_id = $1 AND status = 'pending'`,
    [run.id],
  );
  if (run.parent_run_id) {
    await wakeParentIfWaiting(client, run.id, { ok: false, error });
  }
}

export interface CompleteRunArgs {
  runId: string;
  output: unknown;
  workerId: string;
  fencingToken: number;
}

export async function completeRun(pool: Pool, args: CompleteRunArgs): Promise<void> {
  await withTx(pool, async (client) => {
    const run = await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
    );
    await client.query(
      `UPDATE runs
          SET status = 'completed', output = $2, finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [args.runId, JSON.stringify(args.output ?? null)],
    );
    await removeFromQueue(client, args.runId);
    if (run.parent_run_id) {
      await wakeParentIfWaiting(client, args.runId, { ok: true, output: args.output });
    }
  });
}

export interface FailRunArgs {
  runId: string;
  error: SerializedError;
  stepSeq?: number;
  retry?: RetryPolicy;
  abort?: boolean;
  workerId: string;
  fencingToken: number;
}

export interface FailResult {
  willRetry: boolean;
  nextAttemptAt?: string;
}

export async function failRun(pool: Pool, args: FailRunArgs): Promise<FailResult> {
  return withTx(pool, async (client) => {
    const run = await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
    );
    const maxAttempts = args.retry?.maxAttempts ?? run.max_attempts;

    const willRetry = !args.abort && run.attempt < maxAttempts;

    if (!willRetry) {
      await terminalFail(client, run, args.error);
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
    // Keep the queue row but release the claim (owner + lease) and push
    // availability out. fencing_token stays — it only grows via claims.
    await client.query(
      `UPDATE queue SET locked_by = NULL, locked_at = NULL, lease_until = NULL, available_at = $2
        WHERE run_id = $1`,
      [args.runId, nextAt],
    );
    return { willRetry: true, nextAttemptAt: nextAt.toISOString() };
  });
}

export async function cancelRun(pool: Pool, runId: string): Promise<void> {
  await withTx(pool, async (client) => {
    const run = await getRunRow(client, runId);
    if (!run) throw new KernelError('not_found', `run ${runId} not found`);
    if (['completed', 'failed', 'canceled'].includes(run.status)) {
      // Already terminal — treat cancel as a no-op success.
      return;
    }
    await client.query(
      `UPDATE runs SET status = 'canceled', finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [runId],
    );
    await removeFromQueue(client, runId);
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

export async function retryRun(pool: Pool, runId: string): Promise<{ runId: string }> {
  return withTx(pool, async (client) => {
    const run = await getRunRow(client, runId);
    if (!run) throw new KernelError('not_found', `run ${runId} not found`);
    if (!['failed', 'canceled'].includes(run.status)) {
      throw new KernelError('conflict', `run ${runId} is ${run.status}, not retryable`);
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
 * Logs (best effort, any run status — no fencing)
 * ------------------------------------------------------------------------- */

/** Rows per INSERT. 6 bind params each → 6000 params, well under pg's 65535. */
const LOG_INSERT_CHUNK = 1000;

export async function appendLogs(
  pool: Pool,
  runId: string,
  entries: LogEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const run = await getRunRow(pool, runId);
  if (!run) throw new KernelError('not_found', `run ${runId} not found`);

  // Chunk inserts so a single call can never exceed pg's 65535 bind-param
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

/* ---------------------------------------------------------------------------
 * Run reads: getRun / getRunDetail / waitForResult
 * ------------------------------------------------------------------------- */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const durationMs = (started: Date | null, finished: Date | null): number | null =>
  started && finished ? finished.getTime() - started.getTime() : null;

/** Full run record (camelCase, dates as ISO-8601 strings). */
export interface RunRecord {
  id: string;
  taskId: string;
  status: RunStatus;
  trigger: TriggerType;
  codeVersion: string | null;
  env: string;
  attempt: number;
  maxAttempts: number;
  /** finished − started for terminal runs; null while queued/running/waiting. */
  durationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  payload: unknown;
  output: unknown;
  error: SerializedError | null;
  parentRunId: string | null;
  idempotencyKey: string | null;
  queuedAt: string | null;
}

export interface RunStepRecord {
  seq: number;
  kind: StepKind;
  label: string | null;
  status: StepStatus;
  output: unknown;
  error: SerializedError | null;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WaitRecord {
  id: number;
  stepSeq: number;
  kind: WaitKind;
  resumeAt: string | null;
  childRunId: string | null;
  status: 'pending' | 'completed' | 'canceled';
}

export interface LogRecord {
  id: number;
  stepSeq: number | null;
  level: LogLevel;
  message: string;
  data: unknown;
  ts: string;
}

export interface RunDetailResult {
  run: RunRecord;
  steps: RunStepRecord[];
  waits: WaitRecord[];
  logs: LogRecord[];
}

export async function getRunRecord(pool: Pool, runId: string): Promise<RunRecord> {
  const runRes = await pool.query<{
    id: string;
    task_id: string;
    status: string;
    trigger_type: string;
    code_version: string | null;
    env: string;
    attempt: number;
    max_attempts: number;
    payload: unknown;
    output: unknown;
    error: unknown;
    parent_run_id: string | null;
    idempotency_key: string | null;
    queued_at: Date | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
  }>(
    `SELECT id, task_id, status, trigger_type, code_version, env, attempt, max_attempts,
            payload, output, error, parent_run_id, idempotency_key,
            queued_at, created_at, started_at, finished_at
       FROM runs WHERE id = $1`,
    [runId],
  );
  const r = runRes.rows[0];
  if (!r) throw new KernelError('not_found', `run ${runId} not found`);

  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status as RunStatus,
    trigger: r.trigger_type as TriggerType,
    codeVersion: r.code_version,
    env: r.env,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    durationMs: durationMs(r.started_at, r.finished_at),
    createdAt: r.created_at.toISOString(),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    payload: r.payload,
    output: r.output,
    error: (r.error as SerializedError | null) ?? null,
    parentRunId: r.parent_run_id,
    idempotencyKey: r.idempotency_key,
    queuedAt: iso(r.queued_at),
  };
}

/** Run + steps + waits + logs (logs capped at 1000 rows, oldest first). */
export async function getRunDetail(pool: Pool, runId: string): Promise<RunDetailResult> {
  const run = await getRunRecord(pool, runId);

  const stepsRes = await pool.query<{
    seq: number;
    kind: string;
    label: string | null;
    status: string;
    output: unknown;
    error: unknown;
    attempt: number;
    started_at: Date | null;
    finished_at: Date | null;
  }>(
    `SELECT seq, kind, label, status, output, error, attempt, started_at, finished_at
       FROM run_steps WHERE run_id = $1 ORDER BY seq ASC`,
    [runId],
  );
  const steps: RunStepRecord[] = stepsRes.rows.map((s) => ({
    seq: s.seq,
    kind: s.kind as StepKind,
    label: s.label,
    status: s.status as StepStatus,
    output: s.output,
    error: (s.error as SerializedError | null) ?? null,
    attempt: s.attempt,
    startedAt: iso(s.started_at),
    finishedAt: iso(s.finished_at),
  }));

  const waitsRes = await pool.query<{
    id: number;
    step_seq: number;
    kind: string;
    resume_at: Date | null;
    child_run_id: string | null;
    status: string;
  }>(
    `SELECT id, step_seq, kind, resume_at, child_run_id, status
       FROM waits WHERE run_id = $1 ORDER BY id ASC`,
    [runId],
  );
  const waits: WaitRecord[] = waitsRes.rows.map((w) => ({
    id: Number(w.id),
    stepSeq: w.step_seq,
    kind: w.kind as WaitKind,
    resumeAt: iso(w.resume_at),
    childRunId: w.child_run_id,
    status: w.status as WaitRecord['status'],
  }));

  const logsRes = await pool.query<{
    id: number;
    step_seq: number | null;
    level: string;
    message: string;
    data: unknown;
    ts: Date;
  }>(
    `SELECT id, step_seq, level, message, data, ts
       FROM logs WHERE run_id = $1 ORDER BY id ASC LIMIT 1000`,
    [runId],
  );
  const logs: LogRecord[] = logsRes.rows.map((l) => ({
    id: Number(l.id),
    stepSeq: l.step_seq,
    level: l.level as LogLevel,
    message: l.message,
    data: l.data,
    ts: l.ts.toISOString(),
  }));

  return { run, steps, waits, logs };
}

export interface WaitForResultOptions {
  /** Give up after this long (default 30s). */
  timeoutMs?: number;
  /** Poll interval (default 250ms). */
  pollMs?: number;
}

export interface WaitResult {
  status: RunStatus;
  output?: unknown;
  error?: SerializedError;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a run until it reaches a terminal state. On timeout the latest
 * (non-terminal) status is returned without output/error.
 */
export async function waitForResult(
  pool: Pool,
  runId: string,
  opts: WaitForResultOptions = {},
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const res = await pool.query<{ status: string; output: unknown; error: unknown }>(
      `SELECT status, output, error FROM runs WHERE id = $1`,
      [runId],
    );
    const row = res.rows[0];
    if (!row) throw new KernelError('not_found', `run ${runId} not found`);
    const status = row.status as RunStatus;
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      return {
        status,
        output: row.output ?? undefined,
        error: (row.error as SerializedError | null) ?? undefined,
      };
    }
    if (Date.now() + pollMs >= deadline) return { status };
    await sleep(pollMs);
  }
}
