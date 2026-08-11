/* =============================================================================
   @better-trigger/kernel — kernel run lifecycle.
   Create (idempotent) / steps / suspend / wait-for-child / batch-trigger /
   complete / fail / cancel / retry, plus parent-wakeup for child runs, run
   reads (getRun / getRunDetail / waitForResult) and best-effort logs.
   See docs/backend-contract.md §3.2–3.7. All multi-row mutations are wrapped
   in a single transaction via withTx().

   LOCK ORDER (canonical — every multi-row kernel tx acquires in this order):
     1. queue row  — SELECT ... FROM queue WHERE run_id = $1 FOR UPDATE (0/1 rows)
     2. runs row   — SELECT ... FROM runs  WHERE id     = $1 FOR UPDATE
     3. dependent rows of that run (waits / run_steps)
   A tx that touches two runs orders them child before parent
   (wakeParentIfWaiting runs inside the child's terminal tx and re-acquires
   1→2→3 for the parent); parent_run_id chains are acyclic, so cross-run
   acquisition cannot cycle. The runs row is the true serialization point —
   locking the (possibly absent) queue row first exists purely to keep ordering
   consistent with the claim/reaper paths, whose scans necessarily start from
   the queue. claimRuns is compatible: its SKIP LOCKED candidate scan locks
   queue rows first, and only rows with locked_by IS NULL, so it never contends
   with a fenced op's held claim (those keep locked_by set until
   terminal/suspend); it then locks each candidate's runs row — same 1→2 order.
   That scan joins runs (and tasks) to read the claim's columns in one statement,
   but `FOR UPDATE OF q` restricts the lock to the queue row: the joined tables
   are read, never locked, so position 2 is still first taken by the claiming
   UPDATE that follows.
   The reaper likewise locks expired-lease queue rows via SKIP LOCKED, then the
   runs row; claim and reap candidate sets are disjoint (locked_by IS NULL vs
   lease_until set), and neither scan ever *waits* on a queue row, so neither
   can close a cycle. heartbeat touches only queue rows (never runs) and thus
   cannot participate in a queue↔runs cycle.
   releaseClaims (shutdown hand-back) is the one multi-row scan that deliberately
   does NOT use SKIP LOCKED — it must hand back every claim it holds, not the
   convenient subset — so unlike claim/reap it can *wait* on a queue row. It is
   still ordered 1→2 and holds N queue locks before touching any runs row, so it
   cannot close a cycle with a per-run tx (those take queue before runs too), and
   it orders its own scan by run_id so two shutting-down workers cannot deadlock
   against each other. Its candidate set is locked_by = $me, which is disjoint
   from claimRuns' (locked_by IS NULL) and from every other worker's hand-back.
   The wait-due scanner (orchestrator.scanWaits) is the opposite case — every
   daemon reads the same due waits, so waiting on one is waiting for a peer that
   is already resuming it. Its per-wait tx keeps the 1→2→3 order but takes
   positions 2 and 3 with SKIP LOCKED (tryLockRunRow, then the wait row) and
   abandons the wait the instant either is held: the row stays 'pending' and the
   next tick, which orders by resume_at, finds it at the head again. Position 1
   stays blocking on purpose — a waiting run has no queue row (suspendRun
   deleted it), so it is a 0-row no-op on the path this is about, and actually
   holding it when a stale row does exist is what keeps the closing
   INSERT ... ON CONFLICT on queue from waiting on a queue row while the runs
   row is already held, which is the one direction (2→1) this order forbids.

   FENCING: worker-side writes are guarded by assertOwnedRunning — owner
   (locked_by) from the queue row, status + fencing_token from the runs row,
   both locked in the SAME tx as the mutation that follows. The token lives on
   runs, NOT on the queue row (which is deleted and re-inserted across
   suspend/resume and would reset a queue-held counter), and only ever grows:
   claimRuns increments it, so any later claim invalidates every older token
   for that run. lease_until is deliberately NOT part of validity: an
   expired-but-unreclaimed owner is still the only owner, so its writes stay
   legal until the reaper or a new claim invalidates the token.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import {
  assertNamespace,
  computeBackoffMs,
  KernelError,
  NonDeterminismError,
  parseDuration,
  resolveRetryPolicy,
  RunNotRunningError,
  safeSerializeJson,
  StaleLeaseError,
  TaskNotFoundError,
  type CreatedRun,
  type KernelErrorCode,
  type LogEntry,
  type LogLevel,
  type LogRecord,
  type Namespace,
  type RetryPolicy,
  type RunDetailResult,
  type RunRecord,
  type RunStatus,
  type RunStepRecord,
  type SerializedError,
  type StepKind,
  type StepStatus,
  type TriggerItem,
  type TriggerOptions,
  type TriggerType,
  type WaitForResultOptions,
  type WaitKind,
  type WaitRecord,
  type WaitResult,
} from '@better-trigger/core';
import { stepFingerprint } from './fingerprint';
import { runId as genRunId } from './ids';
import { notifyTerminal, notifyWork } from './notify';
import { enqueue, removeFromQueue } from './queue';

/** Upper bound for a delay before a run becomes available: 10 years in ms. */
const MAX_DELAY_MS = 315_576_000_000;

/* Run-detail read caps (PF3): steps/waits and the logs page are bounded so a
   very long agent run cannot produce an unbounded detail JSON. Logs are paged
   through the id-based `logsBefore` cursor; steps/waits are simply capped at
   the newest rows with a truncated flag (full pagination for them is future
   work, todos/02-performance.md PF3). */
const DEFAULT_DETAIL_LOGS_LIMIT = 200;
const DEFAULT_DETAIL_STEPS_LIMIT = 500;
const DEFAULT_DETAIL_WAITS_LIMIT = 500;
const MAX_DETAIL_PAGE = 5000;

/* Input size limits. Both are enforced here rather than only at the HTTP edge
   because child runs (triggerAndWait / batchTriggerChild) never cross HTTP at
   all — the kernel is the one boundary every created run passes through.
   The payload lands verbatim in a jsonb column and is re-read on every attempt,
   so an unbounded one is a memory *and* a storage problem; big objects belong
   in object storage with only a reference in the payload (the usual durable
   execution advice). The batch cap is about the transaction: every item is two
   INSERTs inside ONE tx, so an unbounded array parks a long write tx on top of
   the queue rows and stalls every claim behind it. */
const DEFAULT_MAX_BATCH_ITEMS = 500;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

/* Serialized-size caps for the other values that land verbatim in jsonb/text
   columns (C3): step output/error (run_steps), run output/error (runs) and
   log data (logs). Same reasoning as the payload cap — the value is copied
   into a column, re-read on every replay and rendered in the dashboard, so an
   unbounded one is a memory and a storage problem; big objects belong in
   object storage with only a reference in the value (see
   apps/worker/README.md "Request limits"). Unlike the payload cap, a value
   that fails these caps must still leave a trace: a step whose output cannot
   be recorded is written as a FAILED step with a stable diagnostic, an error
   record that is too big degrades to a SerializationError stub, and an
   over-limit log line keeps its message and omits its data. Every limit is
   overridable by env and read per call (same pattern as maxPayloadBytes). */
const DEFAULT_STEP_OUTPUT_MAX_BYTES = 256 * 1024;
const DEFAULT_RUN_OUTPUT_MAX_BYTES = 256 * 1024;
const DEFAULT_ERROR_MAX_BYTES = 64 * 1024;
const DEFAULT_LOG_DATA_MAX_BYTES = 16 * 1024;
/** Per-line message cap: an over-long message is truncated (with an ellipsis)
 *  rather than dropped — the line must survive, its verbosity may not. */
const DEFAULT_LOG_MESSAGE_MAX_BYTES = 64 * 1024;
/** Per-INSERT cap for logs: the batch the executor flushes is split into as
 *  many statements as it takes to stay under this AND under pg's bind-param
 *  ceiling (LOG_INSERT_CHUNK rows). */
const DEFAULT_LOG_BATCH_MAX_BYTES = 256 * 1024;
/** JSON envelope a child's output gains when it is copied into the parent's
 *  trigger-and-wait step row — {"id":"run_…","ok":true,"output":<out>} — so
 *  completeRun caps the child output against the tighter of the two output
 *  caps minus this margin: the parent-step copy can then never overflow and
 *  strand the parent in a replay loop (see completeRun). */
const STEP_OUTPUT_ENVELOPE_BYTES = 128;

/* How many times the reaper may hand a run back after a worker vanished under
   it. Deliberately generous: infrastructure churn (a deploy, an OOM kill, a
   laptop that slept) is not the user's code failing, so it must not eat
   max_attempts — but an unbounded budget would let a run that kills every
   worker it touches cycle forever, so there is still a ceiling. */
const DEFAULT_MAX_RECOVERIES = 10;

/**
 * Read a positive-integer limit from the environment; absent or unparseable
 * falls back to the default rather than disabling the limit.
 * Read per call rather than captured at import time: the daemon owns no config
 * object down here, and parsing an int is nothing next to the INSERT it guards.
 */
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Max items accepted by one batchTrigger (BETTER_TRIGGER_MAX_BATCH). */
const maxBatchItems = () => envLimit('BETTER_TRIGGER_MAX_BATCH', DEFAULT_MAX_BATCH_ITEMS);
/** Max serialized payload size for one run (BETTER_TRIGGER_MAX_PAYLOAD_BYTES). */
const maxPayloadBytes = () =>
  envLimit('BETTER_TRIGGER_MAX_PAYLOAD_BYTES', DEFAULT_MAX_PAYLOAD_BYTES);
/** Max serialized step output/error (BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES). */
const stepOutputMaxBytes = () =>
  envLimit('BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES', DEFAULT_STEP_OUTPUT_MAX_BYTES);
/** Max serialized run output (BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES). */
const runOutputMaxBytes = () =>
  envLimit('BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES', DEFAULT_RUN_OUTPUT_MAX_BYTES);
/** Max serialized error record (BETTER_TRIGGER_ERROR_MAX_BYTES). */
const errorMaxBytes = () => envLimit('BETTER_TRIGGER_ERROR_MAX_BYTES', DEFAULT_ERROR_MAX_BYTES);
/** Max serialized `data` on one log line (BETTER_TRIGGER_LOG_DATA_MAX_BYTES). */
const logDataMaxBytes = () =>
  envLimit('BETTER_TRIGGER_LOG_DATA_MAX_BYTES', DEFAULT_LOG_DATA_MAX_BYTES);
/** Max serialized message on one log line (BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES). */
const logMessageMaxBytes = () =>
  envLimit('BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES', DEFAULT_LOG_MESSAGE_MAX_BYTES);
/** Max serialized payload of one log INSERT (BETTER_TRIGGER_LOG_BATCH_MAX_BYTES). */
const logBatchMaxBytes = () =>
  envLimit('BETTER_TRIGGER_LOG_BATCH_MAX_BYTES', DEFAULT_LOG_BATCH_MAX_BYTES);

/**
 * Reaper recovery budget stamped on new runs (BETTER_TRIGGER_MAX_RECOVERIES).
 * Read with its own parser rather than envLimit: 0 is a meaningful setting here
 * ("never recover a lost run, fail it the moment its lease expires") whereas
 * envLimit treats 0 as garbage and falls back to the default.
 */
function maxRecoveries(): number {
  const raw = process.env.BETTER_TRIGGER_MAX_RECOVERIES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_RECOVERIES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MAX_RECOVERIES;
}

/** Shared by both batch entry points; checked before any tx is opened. */
function assertBatchSize(items: TriggerItem[]): void {
  const max = maxBatchItems();
  if (items.length > max) {
    throw new KernelError(
      'bad_request',
      `items must contain at most ${max} entries (split larger fan-outs into batches)`,
    );
  }
}

/** Turn a safeSerializeJson failure into the KernelError the host maps to a
 *  4xx (serialization_error → 400, payload_too_large → 413). */
function throwSerializeFailure(res: { ok: false; code: KernelErrorCode; message: string }): never {
  throw new KernelError(res.code, res.message);
}

/**
 * Serialize an error record (runs.error / run_steps.error) for storage,
 * degrading instead of failing the write: a run or step that cannot record
 * its own error must still transition — a failed failure-report would strand
 * the run in a reap/retry loop. On failure the stored record is a stable
 * SerializationError that names the problem.
 */
function serializeErrorForStorage(error: SerializedError): string {
  const res = safeSerializeJson(error, errorMaxBytes(), 'error');
  if (res.ok) return res.json;
  // The degraded record is fixed-shape and small; if even it cannot fit an
  // operator-tuned tiny cap, fall back to a literal (always valid JSON).
  const stub = safeSerializeJson(
    { name: 'SerializationError', message: `error could not be stored: ${res.message}` },
    errorMaxBytes(),
    'error',
  );
  return stub.ok ? stub.json : '{"name":"SerializationError","message":"error could not be stored"}';
}

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
  /** Infrastructure hand-backs (reaper recoveries), NOT user-code failures —
   *  a separate budget from attempt/max_attempts (see the reaper). */
  recoveries: number;
  max_recoveries: number;
  parent_run_id: string | null;
  payload: unknown;
  project_id: string;
  env: string;
  concurrency_key: string | null;
  /** Copy of the queue row's priority, kept on runs so it survives the queue
   *  row's deletion at terminal (retryRun reads it; see createRunIn). */
  priority: number;
  code_version: string | null;
  /** Monotonic claim counter (bigint → text through pg). */
  fencing_token: string;
}

const RUN_ROW_COLS = `id, task_id, status, attempt, max_attempts,
            recoveries, max_recoveries, parent_run_id,
            payload, project_id, env, concurrency_key, priority, code_version, fencing_token`;

export async function getRunRow(
  db: Pool | PoolClient,
  id: string,
  namespace: Namespace,
): Promise<RunRow | null> {
  const res = await db.query<RunRow>(
    `SELECT ${RUN_ROW_COLS} FROM runs WHERE id = $1 AND project_id = $2 AND env = $3`,
    [id, namespace.projectId, namespace.env],
  );
  return res.rows[0] ?? null;
}

/**
 * Lock + read a runs row (canonical lock position 2 — the caller must already
 * hold / have attempted the run's queue-row lock; see file header).
 */
export async function lockRunRow(
  client: PoolClient,
  id: string,
  namespace: Namespace,
): Promise<RunRow | null> {
  const res = await client.query<RunRow>(
    `SELECT ${RUN_ROW_COLS} FROM runs WHERE id = $1 AND project_id = $2 AND env = $3 FOR UPDATE`,
    [id, namespace.projectId, namespace.env],
  );
  return res.rows[0] ?? null;
}

/**
 * Non-blocking variant of lockRunRow (same canonical position 2). Returns null
 * both when the run is gone and when another transaction holds its row — the
 * caller cannot tell the two apart and must not care: both mean "not mine right
 * now, come back later". Only for scans that re-derive their candidates every
 * tick (orchestrator.scanWaits); a fenced worker write must use lockRunRow, for
 * which "someone else holds it" is a wait, never a skip.
 */
export async function tryLockRunRow(
  client: PoolClient,
  id: string,
  namespace: Namespace,
): Promise<RunRow | null> {
  const res = await client.query<RunRow>(
    `SELECT ${RUN_ROW_COLS} FROM runs WHERE id = $1 AND project_id = $2 AND env = $3 FOR UPDATE SKIP LOCKED`,
    [id, namespace.projectId, namespace.env],
  );
  return res.rows[0] ?? null;
}

/** Canonical lock position 1: the run's queue row, 0 or 1 rows (see header). */
async function lockQueueRow(
  client: PoolClient,
  runId: string,
  namespace: Namespace,
): Promise<{ locked_by: string | null } | null> {
  const res = await client.query<{ locked_by: string | null }>(
    `SELECT locked_by FROM queue WHERE run_id = $1 AND project_id = $2 AND env = $3 FOR UPDATE`,
    [runId, namespace.projectId, namespace.env],
  );
  return res.rows[0] ?? null;
}

/**
 * Fencing check — assert a worker may report on this run: lock the queue row
 * (owner check; FOR UPDATE serializes against claims and the reaper), then
 * lock the runs row and require status 'running' + this claim's fencing token,
 * all in the caller's transaction so the mutation that follows is atomic with
 * the check. lease_until is NOT checked (see file header). Run in non-running
 * state → RunNotRunningError; owner/token mismatch → StaleLeaseError.
 */
async function assertOwnedRunning(
  client: PoolClient,
  runId: string,
  workerId: string,
  fencingToken: number,
  namespace: Namespace,
): Promise<RunRow> {
  const owner = await lockQueueRow(client, runId, namespace);
  const run = await lockRunRow(client, runId, namespace);
  if (!run) throw new KernelError('not_found', `run ${runId} not found`);
  if (run.status !== 'running') {
    throw new RunNotRunningError(`run ${runId} is ${run.status}`);
  }
  if (
    !owner ||
    owner.locked_by !== workerId ||
    Number(run.fencing_token) !== fencingToken
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
  /**
   * The namespace the run is created in — resolved once by the host boundary,
   * never inferred here. Child runs inherit their parent's namespace, retries
   * inherit the source run's (C2).
   */
  namespace: Namespace;
  /** Require the task to exist (trigger API). */
  requireTask?: boolean;
}

/**
 * Create a run + enqueue it. If options.idempotencyKey matches an existing run
 * for the same task, the existing run id is returned with idempotent=true.
 *
 * The `work` notification is sent inside the tx only when a NEW run was
 * enqueued — an idempotency conflict created no work, so it notifies nothing
 * (PF2; the notification is delivered at COMMIT, so a rollback sends nothing).
 */
export async function createRun(pool: Pool, args: CreateRunArgs): Promise<CreatedRun> {
  return withTx(pool, async (c) => {
    const created = await createRunIn(c, args);
    if (!created.idempotent) await notifyWork(c);
    return created;
  });
}

export async function createRunIn(
  client: PoolClient,
  args: CreateRunArgs,
): Promise<CreatedRun> {
  assertNamespace(args.namespace);
  // A non-object `options` (a JSON string, an array) would otherwise have every
  // key read as undefined — the run silently loses the caller's intent.
  if (args.options != null && (typeof args.options !== 'object' || Array.isArray(args.options))) {
    throw new KernelError('bad_request', 'options must be an object');
  }
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

  // Same for the options that land in text columns: pg does not type-check them
  // (it JSON.stringifies an object into the column), so a wrong-typed key would
  // silently corrupt idempotency / concurrency grouping instead of failing.
  // Empty strings are refused too, and not just for tidiness: `''` is falsy but
  // non-null, so it slips between the two ways this function reads these keys —
  // the INSERT picks its branch on truthiness (no ON CONFLICT target) while the
  // bound value is chosen with `??` (the empty string survives as non-NULL), so
  // a second trigger with idempotencyKey '' hits the partial unique index
  // runs_task_idempotency_uniq without a DO NOTHING to absorb it → pg 23505,
  // which is not a KernelError and would surface as a 500. Same class of
  // mismatch for concurrencyKey (all '' runs silently share one group). No key
  // has a meaningful empty spelling, so reject early rather than let it reach
  // the database. (env/projectId are validated by assertNamespace — the run's
  // namespace comes from args.namespace, never from these options.)
  for (const key of ['idempotencyKey', 'concurrencyKey', 'env', 'projectId'] as const) {
    if (opts[key] == null) continue;
    if (typeof opts[key] !== 'string') {
      throw new KernelError('bad_request', `${key} must be a string`);
    }
    if (opts[key] === '') {
      throw new KernelError('bad_request', `${key} must not be empty`);
    }
  }

  // Serialize the payload once, up front: it is what actually reaches pg, so it
  // is what has to be measured, and doing it before the first query means an
  // oversized or unserializable body costs one canonicalization instead of a
  // round trip plus a row. (safeSerializeJson — not raw JSON.stringify: a
  // circular / BigInt payload would otherwise throw a TypeError that reads as
  // a 500, and an over-limit one must surface as payload_too_large, the same
  // family the HTTP body cap uses. `?? null` keeps the pre-existing meaning
  // of an undefined payload — it stores NULL.)
  const payloadSerialized = safeSerializeJson(args.payload ?? null, maxPayloadBytes(), 'payload');
  if (!payloadSerialized.ok) throwSerializeFailure(payloadSerialized);
  const payloadJson = payloadSerialized.json;

  // Resolve task config (retry policy, concurrency limit/key default, and the
  // code version currently registered for the task — stamped on the run below).
  // Scoped to the run's namespace: a staging trigger must never resolve the
  // prod task's retry/concurrency/version (C2).
  const taskRes = await client.query<{
    id: string;
    retry: RetryPolicy | null;
    concurrency_limit: number | null;
    latest_code_version: string | null;
  }>(
    `SELECT id, retry, concurrency_limit, latest_code_version
       FROM tasks WHERE project_id = $1 AND env = $2 AND id = $3`,
    [args.namespace.projectId, args.namespace.env, args.taskId],
  );
  const task = taskRes.rows[0];
  if (!task && args.requireTask) {
    throw new TaskNotFoundError(
      `task ${args.taskId} not registered in ${args.namespace.projectId}/${args.namespace.env}`,
    );
  }

  const policy = resolveRetryPolicy(args.retry ?? task?.retry ?? undefined);
  const hasLimit = (task?.concurrency_limit ?? 0) > 0;
  const concurrencyKey = hasLimit
    ? opts.concurrencyKey ?? args.taskId
    : opts.concurrencyKey ?? null;
  // The namespace is explicit on the args — never defaulted here (C2).
  const { projectId, env } = args.namespace;
  // Resolved once and written to BOTH the runs row and the queue row: the queue
  // row is what the claim scan orders by, the runs copy is what outlives it
  // (the queue row is deleted at terminal / suspend), so a manual retry can
  // reproduce the run's scheduling config instead of silently dropping to 0.
  const priority = opts.priority ?? 0;

  // parseDuration throws a plain Error on garbage ("soon", {}) — at an API
  // boundary that is the caller's mistake, so translate it to bad_request.
  let delayMs = 0;
  if (opts.delay != null) {
    try {
      delayMs = parseDuration(opts.delay);
    } catch {
      throw new KernelError('bad_request', 'delay must be ms or a duration like "10m"');
    }
  }
  if (delayMs > MAX_DELAY_MS) {
    throw new KernelError('bad_request', 'delay exceeds maximum of 10 years');
  }
  const availableAt = new Date(Date.now() + delayMs);
  if (Number.isNaN(availableAt.getTime())) {
    throw new KernelError('bad_request', 'delay produces an invalid date');
  }

  const id = genRunId();

  // Idempotency is enforced atomically by the partial unique index
  // (project_id, env, task_id, idempotency_key) WHERE idempotency_key IS NOT
  // NULL — namespace-scoped, so the same task + key in prod and staging creates
  // two independent runs (C2). INSERT ... ON CONFLICT DO NOTHING wins the race;
  // a loser gets no row back and reads the existing run. (Without a key there
  // is no conflict target, so insert plainly.)
  const insertSql = opts.idempotencyKey
    ? `INSERT INTO runs
         (id, project_id, env, task_id, status, payload, trigger_type, parent_run_id,
          idempotency_key, concurrency_key, priority, attempt, max_attempts,
          recoveries, max_recoveries, code_version,
          queued_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10,1,$11,0,$12,$13, now(), now(), now())
       ON CONFLICT (project_id, env, task_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`
    : `INSERT INTO runs
         (id, project_id, env, task_id, status, payload, trigger_type, parent_run_id,
          idempotency_key, concurrency_key, priority, attempt, max_attempts,
          recoveries, max_recoveries, code_version,
          queued_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10,1,$11,0,$12,$13, now(), now(), now())
       RETURNING id`;
  const inserted = await client.query<{ id: string }>(insertSql, [
    id,
    projectId,
    env,
    args.taskId,
    payloadJson,
    args.triggerType,
    args.parentRunId ?? null,
    opts.idempotencyKey ?? null,
    concurrencyKey,
    priority,
    policy.maxAttempts,
    // Infrastructure budget, not a retry policy: it is an operator setting
    // (BETTER_TRIGGER_MAX_RECOVERIES), not something a trigger call chooses.
    maxRecoveries(),
    // The version registered when the run was created — NOT a pin: claimRuns
    // does not filter on it, so a redeployed worker still picks this run up.
    // It exists so "which code shape was this run's ledger written against?"
    // is answerable after the fact (dashboard, drift post-mortems).
    task?.latest_code_version ?? null,
  ]);

  // No row returned ⇒ idempotency conflict: return the pre-existing run and do
  // NOT enqueue (the original trigger already did). The lookup is namespace-
  // scoped like the unique index that produced the conflict (C2).
  if (inserted.rows.length === 0) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM runs
        WHERE project_id = $1 AND env = $2 AND task_id = $3 AND idempotency_key = $4
        LIMIT 1`,
      [projectId, env, args.taskId, opts.idempotencyKey],
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
    priority,
    concurrencyKey,
    namespace: args.namespace,
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
  /** The namespace the run is created in (resolved by the host boundary). */
  namespace: Namespace;
}

/** Create one 'api' run for a registered task (TaskNotFoundError otherwise). */
export async function trigger(pool: Pool, args: TriggerArgs): Promise<CreatedRun> {
  if (typeof args.taskId !== 'string' || args.taskId.length === 0) {
    throw new KernelError('bad_request', 'taskId must be a non-empty string');
  }
  assertNamespace(args.namespace);
  return createRun(pool, {
    taskId: args.taskId,
    payload: args.payload,
    options: args.options,
    triggerType: 'api',
    namespace: args.namespace,
    requireTask: true,
  });
}

/**
 * Create N 'api' runs in one all-or-nothing transaction. The whole batch shares
 * one namespace — request env/project are data, and mixing namespaces inside
 * one atomic batch would make the idempotency semantics ambiguous.
 */
export async function batchTrigger(
  pool: Pool,
  items: TriggerItem[],
  namespace: Namespace,
): Promise<{ runIds: string[] }> {
  if (!Array.isArray(items)) {
    throw new KernelError('bad_request', 'items must be an array');
  }
  assertNamespace(namespace);
  // Before the per-item walk: an array with 100k entries should not be iterated
  // twice just to be refused.
  assertBatchSize(items);
  for (const item of items) {
    if (typeof item?.taskId !== 'string' || item.taskId.length === 0) {
      throw new KernelError('bad_request', 'item.taskId must be a non-empty string');
    }
  }
  const runIds = await withTx(pool, async (client) => {
    const ids: string[] = [];
    let createdAny = false;
    for (const item of items) {
      const created = await createRunIn(client, {
        taskId: item.taskId,
        payload: item.payload,
        options: item.options,
        triggerType: 'api',
        namespace,
        requireTask: true,
      });
      ids.push(created.runId);
      if (!created.idempotent) createdAny = true;
    }
    // One aggregate `work` notification for the whole batch (the payload is
    // run-id-less by design, so 500 items cost one NOTIFY, far under the
    // 8000-byte cap) — only when at least one NEW run was enqueued.
    if (createdAny) await notifyWork(client);
    return ids;
  });
  return { runIds };
}

/* ---------------------------------------------------------------------------
 * Steps (memoized step rows)
 * ------------------------------------------------------------------------- */

export interface ReportStepArgs {
  runId: string;
  /** The run's namespace (from the ClaimedRun) — every write re-scopes on it. */
  namespace: Namespace;
  seq: number;
  kind: StepKind;
  label?: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: SerializedError;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  /** Replay fingerprint (C1) computed by the reporter at its call site. */
  fingerprint?: string;
  workerId: string;
  fencingToken: number;
}

/** Step-row payload without the fencing credentials. */
export type StepWriteArgs = Omit<ReportStepArgs, 'workerId' | 'fencingToken'>;

/** Result of a step-row write: ok, or the reason the reported output could
 *  not be recorded (the row itself was still written — as a failed step whose
 *  error carries the diagnostic, so the run's timeline keeps its evidence). */
export type StepWriteOutcome =
  | { ok: true }
  | { ok: false; code: KernelErrorCode; message: string };

export async function reportStep(pool: Pool, args: ReportStepArgs): Promise<void> {
  assertNamespace(args.namespace);
  const outcome = await withTx(pool, async (client) => {
    await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
      args.namespace,
    );
    return upsertStep(client, args);
  });
  if (!outcome.ok) {
    // The failed row (with the diagnostic) is already committed — throwing
    // here lets the executor fail the run without rolling the row back.
    throw new KernelError(outcome.code, outcome.message);
  }
}

/**
 * Write one step row, with the C1 immutability rule:
 *
 *   - no existing row (or one that is NOT 'completed', e.g. a failed attempt
 *     being retried) → insert / overwrite freely;
 *   - existing row 'completed' → only an IDEMPOTENT re-report passes:
 *       · fingerprints equal, or either side NULL (legacy data / legacy
 *         reporter) → no-op, the recorded row stays byte-identical;
 *       · both non-NULL and different → NonDeterminismError — the task's code
 *         or inputs changed under a completed step, and replaying the recorded
 *         output would feed stale data to the new code.
 *
 * Postgres cannot express "overwrite only if not completed" inside DO UPDATE
 * alone, so the INSERT ... ON CONFLICT carries a `WHERE status <> 'completed'`
 * guard: a conflicting completed row makes the update a no-op (rowCount 0),
 * and the follow-up SELECT decides whether the no-op was idempotent or a
 * non-deterministic replay. Both statements run in the caller's transaction,
 * so the check is atomic with the write.
 *
 * Every step-row write funnels through here — reportStep, the wait-due resume
 * (orchestrator) and wakeParentIfWaiting — so the immutability rule holds for
 * all of them.
 */
export async function upsertStep(client: PoolClient, args: StepWriteArgs): Promise<StepWriteOutcome> {
  // Serialize before the write: output/error land verbatim in jsonb columns,
  // so they are bounded like the payload (C3). An output that cannot be
  // serialized (circular / BigInt / over the cap) makes the STEP a failed one
  // with a stable diagnostic — the fn produced a value that can never be
  // recorded, so replaying would hit the same wall; the caller (reportStep)
  // turns the returned failure into a run failure after the tx commits. An
  // error record that cannot be serialized degrades instead (the failed-row
  // evidence must land whatever the error looks like).
  let status = args.status;
  let outputJson: string | null = null;
  let errorJson: string | null = null;
  let failure: StepWriteOutcome | null = null;

  if (args.output !== undefined) {
    const res = safeSerializeJson(args.output, stepOutputMaxBytes(), 'output');
    if (res.ok) {
      outputJson = res.json;
    } else {
      failure = { ok: false, code: res.code, message: res.message };
      status = 'failed';
      errorJson = serializeErrorForStorage({
        name: 'SerializationError',
        message: res.message,
      });
    }
  }
  if (failure === null && args.error !== undefined) {
    const res = safeSerializeJson(args.error, errorMaxBytes(), 'error');
    errorJson = res.ok ? res.json : serializeErrorForStorage(args.error);
  }

  const res = await client.query(
    `INSERT INTO run_steps
       (run_id, project_id, env, seq, kind, label, status, output, error, attempt, started_at, finished_at, fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (run_id, seq) DO UPDATE
       SET kind = EXCLUDED.kind,
           label = EXCLUDED.label,
           status = EXCLUDED.status,
           output = EXCLUDED.output,
           error = EXCLUDED.error,
           attempt = EXCLUDED.attempt,
           started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at,
           fingerprint = EXCLUDED.fingerprint
       WHERE run_steps.status <> 'completed'`,
    [
      args.runId,
      args.namespace.projectId,
      args.namespace.env,
      args.seq,
      args.kind,
      args.label ?? null,
      status,
      outputJson,
      errorJson,
      args.attempt,
      args.startedAt,
      args.finishedAt,
      args.fingerprint ?? null,
    ],
  );
  if (res.rowCount === 1) return failure ?? { ok: true }; // inserted, or overwrote a non-completed row

  // Conflict on a 'completed' row: the WHERE clause refused the update. Same
  // transaction, so the row below is the row the INSERT conflicted with.
  const existing = await client.query<{ status: string; fingerprint: string | null }>(
    `SELECT status, fingerprint FROM run_steps
      WHERE run_id = $1 AND project_id = $2 AND env = $3 AND seq = $4`,
    [args.runId, args.namespace.projectId, args.namespace.env, args.seq],
  );
  const row = existing.rows[0];
  // Defensive: no row or a non-completed row means the write actually applied
  // via a path rowCount cannot see; nothing to protect here.
  if (!row || row.status !== 'completed') return { ok: true };

  const stored = row.fingerprint ?? null;
  const incoming = args.fingerprint ?? null;
  // NULL on either side = a ledger (or a reporter) that predates fingerprints:
  // replay proceeds leniently, the recorded row stays untouched.
  if (stored === null || incoming === null || stored === incoming) return { ok: true };

  throw new NonDeterminismError(
    `step fingerprint mismatch at run ${args.runId} seq ${args.seq}` +
      ` (kind '${args.kind}'${args.label ? `, label "${args.label}"` : ''}): ` +
      `the code or its inputs changed since this step was recorded — recorded ` +
      `fingerprint "${stored}", this report "${incoming}". The recorded step row ` +
      `is left intact; the run must fail and be re-executed under a fresh run ` +
      `for the new code to run.`,
  );
}

/* ---------------------------------------------------------------------------
 * Suspend (wait.for / wait.until)
 * ------------------------------------------------------------------------- */

export interface SuspendRunArgs {
  runId: string;
  /** The run's namespace (from the ClaimedRun). */
  namespace: Namespace;
  seq: number;
  label?: string;
  kind: 'duration' | 'until';
  resumeAt: string;
  /** Replay fingerprint (C1) computed by the executor from the DECLARED wait
   *  (duration string / until instant), persisted on the waits row so the
   *  wait-due resume writes the same value to run_steps. */
  fingerprint?: string;
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
  assertNamespace(args.namespace);
  return withTx(pool, async (client) => {
    await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
      args.namespace,
    );
    const resumeAt = new Date(args.resumeAt);

    if (resumeAt.getTime() <= Date.now()) {
      // Already due — record the wait step as completed, keep running, with
      // the executor's fingerprint (the waits path below would carry it too).
      // The output is a literal null, so the write cannot actually fail its
      // serialization check; the outcome is checked anyway so a defensive
      // failure surfaces as a 4xx-class KernelError instead of a silent
      // mismatch between the step row and the caller's expectation.
      const outcome = await upsertStep(client, {
        runId: args.runId,
        namespace: args.namespace,
        seq: args.seq,
        kind: 'wait',
        label: args.label,
        status: 'completed',
        output: null,
        attempt: 1,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        fingerprint: args.fingerprint,
      });
      if (!outcome.ok) throw new KernelError(outcome.code, outcome.message);
      return { resumed: true };
    }

    await client.query(
      `INSERT INTO waits (run_id, project_id, env, step_seq, kind, resume_at, fingerprint, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending', now())`,
      [
        args.runId,
        args.namespace.projectId,
        args.namespace.env,
        args.seq,
        args.kind,
        resumeAt,
        args.fingerprint ?? null,
      ],
    );
    await client.query(
      `UPDATE runs SET status = 'waiting', updated_at = now()
        WHERE id = $1 AND project_id = $2 AND env = $3`,
      [args.runId, args.namespace.projectId, args.namespace.env],
    );
    await removeFromQueue(client, args.runId, args.namespace);
    return { resumed: false };
  });
}

/* ---------------------------------------------------------------------------
 * triggerAndWait (wait-for-child-run)
 * ------------------------------------------------------------------------- */

export interface WaitForChildRunArgs {
  runId: string;
  /** The parent run's namespace — the child is created in the same one (C2). */
  namespace: Namespace;
  seq: number;
  label?: string;
  taskId: string;
  payload: unknown;
  options?: TriggerOptions;
  /** Replay fingerprint (C1) computed by the executor from taskId + payload +
   *  options; persisted on the waits row so wakeParentIfWaiting writes the
   *  same value to the parent's step row. */
  fingerprint?: string;
  workerId: string;
  fencingToken: number;
}

export async function waitForChildRun(
  pool: Pool,
  args: WaitForChildRunArgs,
): Promise<{ childRunId: string }> {
  assertNamespace(args.namespace);
  return withTx(pool, async (client) => {
    const parent = await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
      args.namespace,
    );

    // Idempotent on replay: a completed wait step at this seq means the child
    // already ran; the SDK should normally hit the snapshot, but guard anyway.
    const existingStep = await client.query<{ output: unknown }>(
      `SELECT output FROM run_steps
        WHERE run_id = $1 AND project_id = $2 AND env = $3 AND seq = $4 AND status = 'completed'`,
      [args.runId, args.namespace.projectId, args.namespace.env, args.seq],
    );
    if (existingStep.rows[0]) {
      const out = existingStep.rows[0].output as { id?: string } | null;
      if (out?.id) return { childRunId: out.id };
    }
    // Or a pending wait already created the child.
    const existingWait = await client.query<{ child_run_id: string | null }>(
      `SELECT child_run_id FROM waits
        WHERE run_id = $1 AND project_id = $2 AND env = $3
          AND step_seq = $4 AND kind = 'run' AND status = 'pending'`,
      [args.runId, args.namespace.projectId, args.namespace.env, args.seq],
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
      namespace: { projectId: parent.project_id, env: parent.env },
    });

    await client.query(
      `INSERT INTO waits (run_id, project_id, env, step_seq, kind, child_run_id, fingerprint, status, created_at)
       VALUES ($1,$2,$3,$4,'run',$5,$6,'pending', now())`,
      [
        args.runId,
        args.namespace.projectId,
        args.namespace.env,
        args.seq,
        child.runId,
        args.fingerprint ?? null,
      ],
    );
    await client.query(
      `UPDATE runs SET status = 'waiting', updated_at = now()
        WHERE id = $1 AND project_id = $2 AND env = $3`,
      [args.runId, args.namespace.projectId, args.namespace.env],
    );
    await removeFromQueue(client, args.runId, args.namespace);

    // The child is new executable work — wake the claim loops from the
    // parent's tx. The idempotent early returns above never reach this point.
    await notifyWork(client);

    return { childRunId: child.runId };
  });
}

/* ---------------------------------------------------------------------------
 * batchTrigger (durable step)
 * ------------------------------------------------------------------------- */

export interface BatchTriggerChildArgs {
  runId: string;
  /** The parent run's namespace — the children are created in the same one. */
  namespace: Namespace;
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
  // Same single-tx exposure as the client-side batchTrigger — a fan-out from
  // inside a task can park exactly the same long write tx on the queue.
  assertBatchSize(args.items);
  assertNamespace(args.namespace);
  const outcome = await withTx(pool, async (client) => {
    const parent = await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
      args.namespace,
    );

    // Idempotent: if the step row already exists, return its recorded runIds.
    const existing = await client.query<{ output: unknown }>(
      `SELECT output FROM run_steps
        WHERE run_id = $1 AND project_id = $2 AND env = $3 AND seq = $4`,
      [args.runId, args.namespace.projectId, args.namespace.env, args.seq],
    );
    if (existing.rows[0]) {
      const out = existing.rows[0].output as { runIds?: string[] } | null;
      if (out?.runIds) return { ok: true as const, runIds: out.runIds };
    }

    const runIds: string[] = [];
    for (const item of args.items) {
      const child = await createRunIn(client, {
        taskId: item.taskId,
        payload: item.payload,
        options: item.options,
        triggerType: 'subtask',
        parentRunId: args.runId,
        namespace: { projectId: parent.project_id, env: parent.env },
      });
      runIds.push(child.runId);
    }

    const stepOutcome = await upsertStep(client, {
      runId: args.runId,
      namespace: args.namespace,
      seq: args.seq,
      kind: 'batch-trigger',
      label: args.label,
      status: 'completed',
      output: { runIds },
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      fingerprint: stepFingerprint({
        kind: 'batch-trigger',
        label: args.label ?? null,
        input: { items: args.items },
        codeVersion: parent.code_version,
      }),
    });
    // The children are new executable work; the idempotent early return above
    // (existing step row) never reaches this point.
    await notifyWork(client);
    return stepOutcome.ok
      ? { ok: true as const, runIds }
      : { ok: false as const, failure: stepOutcome };
  });

  if (!outcome.ok) {
    // The batch step's output could not be recorded (e.g. an operator-tuned
    // tiny step cap): the children and the failed step row are already
    // committed in the same tx, and the children must NOT be re-created, so
    // throwing AFTER the commit lets the executor fail the run non-retryably
    // (isUnfixableKernelError → AbortError) — a replay of this seq would
    // otherwise spin up the whole fan-out a second time.
    throw new KernelError(outcome.failure.code, outcome.failure.message);
  }
  return { runIds: outcome.runIds };
}

/* ---------------------------------------------------------------------------
 * Terminal transitions: complete / fail / cancel, with parent wakeup
 * ------------------------------------------------------------------------- */

/**
 * If `childRunId` is awaited by a pending 'run' wait, fill the parent step row
 * with { id, ok, output?, error? } and re-enqueue the parent. Runs inside the
 * caller's transaction (which holds the CHILD's locks — the parent's rows are
 * re-acquired here in canonical order: queue → runs → wait row).
 */
export async function wakeParentIfWaiting(
  client: PoolClient,
  childRunId: string,
  result: { ok: boolean; output?: unknown; error?: SerializedError },
): Promise<void> {
  // Locate the parent's pending wait WITHOUT locking it — the wait row may
  // only be locked after the parent's queue + runs rows (lock order 1→2→3).
  // fingerprint rides along: the executor computed it (taskId + payload +
  // options, C1) when the wait was created, and the step row must carry that
  // exact value so the parent's replay matches it. project_id/env ride along
  // too — the parent's rows are re-acquired scoped to its namespace (C2).
  const waitRes = await client.query<{
    id: number;
    run_id: string;
    project_id: string;
    env: string;
    step_seq: number;
    fingerprint: string | null;
  }>(
    `SELECT id, run_id, project_id, env, step_seq, fingerprint FROM waits
      WHERE child_run_id = $1 AND kind = 'run' AND status = 'pending'`,
    [childRunId],
  );
  const wait = waitRes.rows[0];
  if (!wait) return;

  const parentNs: Namespace = { projectId: wait.project_id, env: wait.env };
  // Parent rows in canonical order: queue row (absent while the parent is
  // waiting → 0 rows, still ordered), runs row, then the wait row — re-checked
  // under its lock since it was located with a plain read above.
  await lockQueueRow(client, wait.run_id, parentNs);
  const parent = await lockRunRow(client, wait.run_id, parentNs);
  const lockedWait = await client.query<{ id: number }>(
    // Row-lock clause LAST (same C2 regression as the orchestrator's wait
    // lock once had: `AND project_id` after `FOR UPDATE` is a 42601 syntax
    // error on every Postgres and silently breaks child completion).
    `SELECT id FROM waits WHERE id = $1 AND status = 'pending'
       AND project_id = $2 AND env = $3
     FOR UPDATE`,
    [wait.id, parentNs.projectId, parentNs.env],
  );
  if (!lockedWait.rows[0]) return; // canceled/completed while ordering locks

  await client.query(
    `UPDATE waits SET status = 'completed' WHERE id = $1
       AND project_id = $2 AND env = $3`,
    [wait.id, parentNs.projectId, parentNs.env],
  );

  const stepOutput: { id: string; ok: boolean; output?: unknown; error?: SerializedError } =
    { id: childRunId, ok: result.ok };
  if (result.output !== undefined) stepOutput.output = result.output;
  if (result.error !== undefined) stepOutput.error = result.error;

  // upsertStep applies the C1 immutability rule like any other step write: a
  // completed row is never overwritten — an equal (or NULL-compatible)
  // fingerprint is an idempotent no-op, a differing one rejects the write.
  const outcome = await upsertStep(client, {
    runId: wait.run_id,
    namespace: parentNs,
    seq: wait.step_seq,
    kind: 'trigger-and-wait',
    label: undefined, // the ledger row stores NULL (upsertStep binds ?? null)
    status: 'completed',
    output: stepOutput,
    attempt: 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    fingerprint: wait.fingerprint ?? undefined,
  });
  if (!outcome.ok) {
    // Defensive: completeRun caps the child output against the tighter of the
    // two output caps, so a child result that fits runs.output always fits the
    // parent's step row. If that invariant ever breaks, the child's terminal
    // tx must NOT commit: a parent whose wait resolved to an unrecordable step
    // row would replay into a duplicate child. Throwing rolls the child's
    // completion back (it stays 'running' for the lease reaper).
    throw new KernelError(outcome.code, outcome.message);
  }

  // Re-enqueue the parent.
  if (parent && parent.status === 'waiting') {
    await client.query(
      `UPDATE runs SET status = 'queued', updated_at = now()
        WHERE id = $1 AND project_id = $2 AND env = $3`,
      [wait.run_id, parentNs.projectId, parentNs.env],
    );
    // Same reason as the timer-wait resume in the orchestrator: waitForChildRun
    // deleted the parent's queue row, and enqueue() defaults an omitted priority
    // to 0 *and* writes it over any surviving row (priority = EXCLUDED.priority),
    // so leaving it out demotes a high-priority parent every time a child
    // finishes (todos/01-correctness.md C7).
    await enqueue(client, {
      runId: wait.run_id,
      availableAt: new Date(),
      priority: parent.priority,
      concurrencyKey: parent.concurrency_key,
      namespace: parentNs,
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
  const ns: Namespace = { projectId: run.project_id, env: run.env };
  await client.query(
    `UPDATE runs
        SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
      WHERE id = $1 AND project_id = $3 AND env = $4`,
    [run.id, serializeErrorForStorage(error), ns.projectId, ns.env],
  );
  await removeFromQueue(client, run.id, ns);
  await client.query(
    `UPDATE waits SET status = 'canceled' WHERE run_id = $1 AND status = 'pending'
       AND project_id = $2 AND env = $3`,
    [run.id, ns.projectId, ns.env],
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
  /** The run's namespace (from the ClaimedRun). */
  namespace: Namespace;
}

export async function completeRun(pool: Pool, args: CompleteRunArgs): Promise<void> {
  assertNamespace(args.namespace);
  await withTx(pool, async (client) => {
    const run = await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
      args.namespace,
    );
    // Serialize before the write, like the payload: the output lands verbatim
    // in runs.output AND is copied into the parent's trigger-and-wait step
    // row, so it is capped by the tighter of the two output caps minus the
    // envelope the step wrapper adds — that guarantees the parent-step copy
    // can never overflow and strand the parent in a replay loop. On failure
    // nothing was written (the tx rolls back) and the executor fails the run:
    // a value that can never be stored must not complete a run.
    const serialized = safeSerializeJson(
      args.output ?? null,
      Math.min(runOutputMaxBytes(), Math.max(1, stepOutputMaxBytes() - STEP_OUTPUT_ENVELOPE_BYTES)),
      'output',
    );
    if (!serialized.ok) throwSerializeFailure(serialized);
    await client.query(
      `UPDATE runs
          SET status = 'completed', output = $2, finished_at = now(), updated_at = now()
        WHERE id = $1 AND project_id = $3 AND env = $4`,
      [args.runId, serialized.json, args.namespace.projectId, args.namespace.env],
    );
    await removeFromQueue(client, args.runId, args.namespace);
    if (run.parent_run_id) {
      await wakeParentIfWaiting(client, args.runId, { ok: true, output: args.output });
    }
    // Terminal: result waiters wake. If a parent was woken inside the same tx,
    // it may also be claimable again — the extra `work` notification is
    // harmless when it was not (the claim scan just comes back empty).
    await notifyTerminal(client, args.runId, args.namespace);
    if (run.parent_run_id) await notifyWork(client);
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
  /** The run's namespace (from the ClaimedRun). */
  namespace: Namespace;
}

export interface FailResult {
  willRetry: boolean;
  nextAttemptAt?: string;
}

export async function failRun(pool: Pool, args: FailRunArgs): Promise<FailResult> {
  assertNamespace(args.namespace);
  return withTx(pool, async (client) => {
    const run = await assertOwnedRunning(
      client,
      args.runId,
      args.workerId,
      args.fencingToken,
      args.namespace,
    );
    const maxAttempts = args.retry?.maxAttempts ?? run.max_attempts;

    const willRetry = !args.abort && run.attempt < maxAttempts;

    if (!willRetry) {
      await terminalFail(client, run, args.error);
      // Terminal (no retry): wake result waiters, and the parent if there is
      // one to wake. The extra `work` notification is harmless when no parent
      // actually got re-enqueued.
      await notifyTerminal(client, args.runId, args.namespace);
      if (run.parent_run_id) await notifyWork(client);
      return { willRetry: false };
    }

    const backoff = computeBackoffMs(run.attempt, args.retry);
    const nextAt = new Date(Date.now() + backoff);
    await client.query(
      `UPDATE runs
          SET status = 'queued', attempt = attempt + 1, error = $2, updated_at = now()
        WHERE id = $1 AND project_id = $3 AND env = $4`,
      [args.runId, serializeErrorForStorage(args.error), args.namespace.projectId, args.namespace.env],
    );
    // Keep the queue row but release the claim (owner + lease) and push
    // availability out. runs.fencing_token stays — it only grows via claims.
    await client.query(
      `UPDATE queue SET locked_by = NULL, locked_at = NULL, lease_until = NULL, available_at = $2
        WHERE run_id = $1 AND project_id = $3 AND env = $4`,
      [args.runId, nextAt, args.namespace.projectId, args.namespace.env],
    );
    // Retry branch: the run is NOT terminal, so waiters must keep waiting —
    // only the claim loops get the `work` notification (the run is claimable
    // again after its backoff; a wake before available_at just comes back
    // empty).
    await notifyWork(client);
    return { willRetry: true, nextAttemptAt: nextAt.toISOString() };
  });
}

export async function cancelRun(
  pool: Pool,
  runId: string,
  namespace: Namespace,
): Promise<void> {
  assertNamespace(namespace);
  await withTx(pool, async (client) => {
    // Canonical lock order: queue row (if any) before the runs row, so cancel
    // can never AB-BA against a fenced op holding the claim (see file header).
    await lockQueueRow(client, runId, namespace);
    const run = await lockRunRow(client, runId, namespace);
    if (!run) throw new KernelError('not_found', `run ${runId} not found`);
    if (['completed', 'failed', 'canceled'].includes(run.status)) {
      // Already terminal — treat cancel as a no-op success.
      return;
    }
    await client.query(
      `UPDATE runs SET status = 'canceled', finished_at = now(), updated_at = now()
        WHERE id = $1 AND project_id = $2 AND env = $3`,
      [runId, namespace.projectId, namespace.env],
    );
    await removeFromQueue(client, runId, namespace);
    await client.query(
      `UPDATE waits SET status = 'canceled' WHERE run_id = $1 AND status = 'pending'
         AND project_id = $2 AND env = $3`,
      [runId, namespace.projectId, namespace.env],
    );
    if (run.parent_run_id) {
      await wakeParentIfWaiting(client, runId, {
        ok: false,
        error: { message: 'child canceled' },
      });
    }
    // Terminal: wake result waiters (and the claim loops if a parent may have
    // been re-enqueued — harmless when it was not). The already-terminal
    // no-op early return above never reaches this point.
    await notifyTerminal(client, runId, namespace);
    if (run.parent_run_id) await notifyWork(client);
  });
}

export async function retryRun(
  pool: Pool,
  runId: string,
  namespace: Namespace,
): Promise<{ runId: string }> {
  assertNamespace(namespace);
  return withTx(pool, async (client) => {
    // Reads the (terminal) source run without locking and only inserts fresh
    // rows via createRunIn — no existing-row locks, so trivially order-safe.
    // Scoped to the given namespace: a retry can only ever re-run a run inside
    // it, and the new run inherits that namespace (C2).
    const run = await getRunRow(client, runId, namespace);
    if (!run) throw new KernelError('not_found', `run ${runId} not found`);
    if (!['failed', 'canceled'].includes(run.status)) {
      throw new KernelError('conflict', `run ${runId} is ${run.status}, not retryable`);
    }
    const created = await createRunIn(client, {
      taskId: run.task_id,
      payload: run.payload,
      // Carry the source run's scheduling config over: a retry of an urgent,
      // separately-throttled run must not silently land at priority 0 in the
      // task's default concurrency bucket. priority comes off the runs row
      // (the queue row is long gone — the source run is terminal), and a NULL
      // concurrency_key means "the task has no limit", which createRunIn
      // re-derives from the task anyway.
      options: {
        priority: run.priority,
        ...(run.concurrency_key !== null ? { concurrencyKey: run.concurrency_key } : {}),
      },
      // NOT carried over: idempotencyKey — reusing it would make the retry
      // collide with the very run it is retrying and hand back its id.
      triggerType: 'retry',
      namespace,
    });
    await notifyWork(client);
    return { runId: created.runId };
  });
}

/* ---------------------------------------------------------------------------
 * Logs (best effort, any non-terminal run — no fencing)
 * ------------------------------------------------------------------------- */

/** Rows per INSERT. 5 bind params each (+1 shared run_id) → 5001 params, well
 *  under pg's 65535. */
const LOG_INSERT_CHUNK = 1000;
/** Fixed per-row allowance for the VALUES syntax, casts and separators around
 *  one row's parameters, added to the parameter bytes when packing chunks. */
const LOG_ROW_SQL_OVERHEAD_BYTES = 64;

/** One log line prepared for binding: everything JSON-encoded up front. */
interface PreparedLogRow {
  stepSeq: number | null;
  level: string;
  message: string;
  dataJson: string | null;
  ts: string;
  /** Estimated bytes the row occupies in one INSERT statement's parameters. */
  bytes: number;
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** Truncate a string to at most maxBytes UTF-8 bytes, appending '…' (3 bytes)
 *  when it was cut. Iterates code points so a multi-byte character is never
 *  split. */
function truncateUtf8(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - 3);
  let out = '';
  let used = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (used + b > budget) break;
    out += ch;
    used += b;
  }
  return `${out}…`;
}

function preparedRowBytes(r: PreparedLogRow): number {
  return (
    utf8Bytes(String(r.stepSeq)) +
    utf8Bytes(r.level) +
    utf8Bytes(r.message) +
    utf8Bytes(r.dataJson ?? 'null') +
    utf8Bytes(r.ts) +
    LOG_ROW_SQL_OVERHEAD_BYTES
  );
}

/**
 * Serialize one log line's data and cap its message; an over-limit or
 * unserializable data value is replaced with a small diagnostic record so the
 * LINE survives (logs must not be lost; data may be).
 */
function prepareLogRow(e: LogEntry): PreparedLogRow {
  let dataJson: string | null = null;
  if (e.data !== undefined) {
    const res = safeSerializeJson(e.data, logDataMaxBytes(), 'data');
    if (res.ok) dataJson = res.json;
    else dataJson = JSON.stringify({ omitted: true, reason: res.message });
  }
  const row: PreparedLogRow = {
    stepSeq: e.stepSeq ?? null,
    level: e.level,
    message: truncateUtf8(e.message, logMessageMaxBytes()),
    dataJson,
    ts: e.ts,
    bytes: 0,
  };
  return { ...row, bytes: preparedRowBytes(row) };
}

/**
 * A single line that already exceeds the whole batch cap: drop its data
 * first, then trim the message, so the line still fits inside one statement.
 */
function shrinkRowForBatch(row: PreparedLogRow, maxBytes: number): PreparedLogRow {
  let next: PreparedLogRow = row;
  if (next.dataJson !== null) {
    next = {
      ...next,
      dataJson: JSON.stringify({ omitted: true, reason: 'data omitted: line exceeds the log batch cap' }),
    };
  }
  if (preparedRowBytes(next) > maxBytes) {
    // Budget for the message = what the row leaves after everything else.
    const budget = Math.max(0, maxBytes - (preparedRowBytes(next) - utf8Bytes(next.message)));
    next = { ...next, message: truncateUtf8(next.message, budget) };
  }
  return { ...next, bytes: preparedRowBytes(next) };
}

/**
 * Append log lines to a run. Best effort in both directions: no fencing (a
 * superseded executor's last flush is still worth keeping) and no error when
 * the write lands nowhere.
 *
 * The existence + liveness test rides along with the INSERT instead of being a
 * separate SELECT: `WHERE EXISTS (... finished_at IS NULL)` writes 0 rows for a
 * run that is gone or already terminal, which drops the per-flush round trip
 * (the executor flushes once a second per in-flight run) and keeps lines from
 * appearing *after* a run's own terminal timestamp — a fenced-out executor used
 * to be able to write those, and a history where logs continue past the end is
 * actively misleading to read.
 *
 * The trade-off, taken deliberately: a line emitted in the same instant the run
 * is being finalized can be evaluated against the already-terminal row and
 * silently dropped. Serializing against that would mean taking the runs row
 * under FOR UPDATE on every flush, which is the cost this path refuses to pay —
 * and losing the last few milliseconds of logs is what "best effort" was
 * already promising.
 *
 * Since PF6 added logs.run_id REFERENCES runs(id) ON DELETE CASCADE, the INSERT
 * does take a FOR KEY SHARE lock on the parent run row — enough to block behind
 * a concurrent FOR UPDATE holder, not enough to serialize against one the way
 * the paragraph above rules out. No deadlock edge comes with it: this is a
 * single autocommit statement that holds no other lock while it waits.
 */
export async function appendLogs(
  pool: Pool,
  runId: string,
  namespace: Namespace,
  entries: LogEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  assertNamespace(namespace);

  // Prepare every line up front (per-line data cap + message cap applied
  // here), shrink any line that would alone exceed the batch cap, then pack
  // chunks by BOTH bounds: pg's 65535 bind-param ceiling (LOG_INSERT_CHUNK
  // rows per statement) and the serialized byte cap for one statement
  // (BETTER_TRIGGER_LOG_BATCH_MAX_BYTES) — a flush over the byte cap is split
  // into more statements, never a single oversized one. Each chunk re-checks
  // the run, so a run that goes terminal mid-flush simply stops absorbing the
  // remaining chunks.
  const maxBatchBytes = logBatchMaxBytes();
  const rows: PreparedLogRow[] = [];
  for (const e of entries) {
    let row = prepareLogRow(e);
    if (preparedRowBytes(row) > maxBatchBytes) {
      row = shrinkRowForBatch(row, maxBatchBytes);
    }
    // Under an operator-tuned cap smaller than the smallest possible line the
    // line cannot be written at all; drop it rather than emit an oversized
    // INSERT (a 1-byte cap cannot be honored any other way).
    if (preparedRowBytes(row) <= maxBatchBytes) rows.push(row);
  }
  const chunks: PreparedLogRow[][] = [];
  let current: PreparedLogRow[] = [];
  let currentBytes = 0;
  for (const row of rows) {
    if (
      current.length > 0 &&
      (current.length >= LOG_INSERT_CHUNK || currentBytes + row.bytes > maxBatchBytes)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += row.bytes;
  }
  if (current.length > 0) chunks.push(current);

  for (const chunk of chunks) {
    const values: string[] = [];
    // $1 is the run id, $2/$3 the namespace (shared by the SELECT list and the
    // EXISTS test); row params start at $4.
    const params: unknown[] = [runId, namespace.projectId, namespace.env];
    let i = 4;
    for (const r of chunk) {
      // Casts are required, not decoration: inside a VALUES sub-select pg has no
      // target column to infer an untyped parameter from, so it would settle on
      // text and then refuse to assign text to step_seq / data / ts.
      values.push(
        `($${i++}::int, $${i++}::text, $${i++}::text, $${i++}::jsonb, $${i++}::timestamptz)`,
      );
      params.push(r.stepSeq, r.level, r.message, r.dataJson, r.ts);
    }
    await pool.query(
      `INSERT INTO logs (project_id, env, run_id, step_seq, level, message, data, ts)
       SELECT $2::text, $3::text, $1::text, v.step_seq, v.level, v.message, v.data, v.ts
         FROM (VALUES ${values.join(',')}) AS v(step_seq, level, message, data, ts)
        WHERE EXISTS (
          SELECT 1 FROM runs WHERE id = $1 AND finished_at IS NULL
            AND project_id = $2 AND env = $3
        )`,
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

export async function getRunRecord(
  db: Pool | PoolClient,
  runId: string,
  namespace: Namespace,
): Promise<RunRecord> {
  assertNamespace(namespace);
  const runRes = await db.query<{
    id: string;
    task_id: string;
    status: string;
    trigger_type: string;
    code_version: string | null;
    project_id: string;
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
    `SELECT id, task_id, status, trigger_type, code_version, project_id, env,
            attempt, max_attempts, payload, output, error, parent_run_id,
            idempotency_key, queued_at, created_at, started_at, finished_at
       FROM runs WHERE id = $1 AND project_id = $2 AND env = $3`,
    [runId, namespace.projectId, namespace.env],
  );
  const r = runRes.rows[0];
  if (!r) throw new KernelError('not_found', `run ${runId} not found`);

  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status as RunStatus,
    trigger: r.trigger_type as TriggerType,
    codeVersion: r.code_version,
    projectId: r.project_id,
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

/** Options for getRunDetail (PF3). All limits optional; defaults keep a single
 *  detail page bounded (~200 log lines, 500 steps / 500 waits at most). */
export interface RunDetailOptions {
  /** Page size for logs — the newest N lines, ascending in the response.
   *  Default 200; capped at MAX_DETAIL_PAGE. */
  logsLimit?: number;
  /** Return only logs with id < logsBefore — the page strictly older than the
   *  one whose oldest line carries this id (the response's logsNextCursor). */
  logsBefore?: number;
  /** Cap on steps rows (newest kept). Default 500; capped at MAX_DETAIL_PAGE. */
  stepsLimit?: number;
  /** Cap on waits rows (newest kept). Default 500; capped at MAX_DETAIL_PAGE. */
  waitsLimit?: number;
}

/** Clamp an optional count to [1, max] with a fallback — a page size of 0 or a
 *  negative one is a caller bug, refused before it reaches pg as `LIMIT 0`. */
function detailLimit(name: string, v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new KernelError('bad_request', `${name} must be a positive integer`);
  }
  return Math.min(v, MAX_DETAIL_PAGE);
}

/**
 * Run + steps + waits + logs from ONE snapshot. All four reads run in a single
 * REPEATABLE READ transaction (a dedicated connection from the pool, released
 * on every path), so a run changing mid-read cannot produce a detail whose
 * parts disagree: the run status, ledger and logs all reflect the same point
 * in time (PF3, todos/02-performance.md).
 *
 * Logs come back as the NEWEST page (default 200 lines) in ascending id order
 * (chronological display); `logsNextCursor` carries the oldest line's id when
 * older logs exist, and passing it back as `logsBefore` fetches the previous
 * page — so a 1200-line run shows its last error by default and pages back to
 * the beginning. steps/waits are capped at the newest rows with a truncated
 * flag.
 */
export async function getRunDetail(
  pool: Pool,
  runId: string,
  namespace: Namespace,
  opts: RunDetailOptions = {},
): Promise<RunDetailResult> {
  assertNamespace(namespace);
  const logsLimit = detailLimit('logsLimit', opts.logsLimit, DEFAULT_DETAIL_LOGS_LIMIT);
  const stepsLimit = detailLimit('stepsLimit', opts.stepsLimit, DEFAULT_DETAIL_STEPS_LIMIT);
  const waitsLimit = detailLimit('waitsLimit', opts.waitsLimit, DEFAULT_DETAIL_WAITS_LIMIT);
  const logsBefore = opts.logsBefore;
  if (logsBefore !== undefined && (!Number.isSafeInteger(logsBefore) || logsBefore < 1)) {
    throw new KernelError('bad_request', 'logsBefore must be a positive integer');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const detail = await readRunDetail(client, runId, namespace, {
      logsLimit,
      logsBefore,
      stepsLimit,
      waitsLimit,
    });
    await client.query('COMMIT');
    return detail;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The four reads of getRunDetail, executed on an already-open tx client. */
async function readRunDetail(
  client: PoolClient,
  runId: string,
  namespace: Namespace,
  opts: Required<Pick<RunDetailOptions, 'logsLimit' | 'stepsLimit' | 'waitsLimit'>> & {
    logsBefore?: number;
  },
): Promise<RunDetailResult> {
  const run = await getRunRecord(client, runId, namespace);

  const stepsRes = await client.query<{
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
       FROM run_steps WHERE run_id = $1 AND project_id = $2 AND env = $3
      ORDER BY seq DESC LIMIT $4`,
    [runId, namespace.projectId, namespace.env, opts.stepsLimit + 1],
  );
  // Newest rows kept, oldest cut — the extra probe row (limit+1) is the proof
  // that older ones exist, and doubles as the truncation flag.
  const stepsTruncated = stepsRes.rows.length > opts.stepsLimit;
  const keptSteps = stepsTruncated ? stepsRes.rows.slice(0, opts.stepsLimit) : stepsRes.rows;
  const steps: RunStepRecord[] = keptSteps.reverse().map((s) => ({
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

  const waitsRes = await client.query<{
    id: number;
    step_seq: number;
    kind: string;
    resume_at: Date | null;
    child_run_id: string | null;
    status: string;
  }>(
    `SELECT id, step_seq, kind, resume_at, child_run_id, status
       FROM waits WHERE run_id = $1 AND project_id = $2 AND env = $3
      ORDER BY id DESC LIMIT $4`,
    [runId, namespace.projectId, namespace.env, opts.waitsLimit + 1],
  );
  const waitsTruncated = waitsRes.rows.length > opts.waitsLimit;
  const keptWaits = waitsTruncated ? waitsRes.rows.slice(0, opts.waitsLimit) : waitsRes.rows;
  const waits: WaitRecord[] = keptWaits.reverse().map((w) => ({
    id: Number(w.id),
    stepSeq: w.step_seq,
    kind: w.kind as WaitKind,
    resumeAt: iso(w.resume_at),
    childRunId: w.child_run_id,
    status: w.status as WaitRecord['status'],
  }));

  // Newest page, id-descending in SQL, reversed in memory for chronological
  // display; `id < $n` walks back through older pages via the cursor.
  const logsSql = opts.logsBefore === undefined
    ? `SELECT id, step_seq, level, message, data, ts
         FROM logs WHERE run_id = $1 AND project_id = $2 AND env = $3
        ORDER BY id DESC LIMIT $4`
    : `SELECT id, step_seq, level, message, data, ts
         FROM logs WHERE run_id = $1 AND project_id = $2 AND env = $3 AND id < $4
        ORDER BY id DESC LIMIT $5`;
  const logsParams = opts.logsBefore === undefined
    ? [runId, namespace.projectId, namespace.env, opts.logsLimit + 1]
    : [runId, namespace.projectId, namespace.env, opts.logsBefore, opts.logsLimit + 1];
  const logsRes = await client.query<{
    id: number;
    step_seq: number | null;
    level: string;
    message: string;
    data: unknown;
    ts: Date;
  }>(logsSql, logsParams);
  const logsTruncated = logsRes.rows.length > opts.logsLimit;
  const keptLogs = logsTruncated ? logsRes.rows.slice(0, opts.logsLimit) : logsRes.rows;
  const logs: LogRecord[] = keptLogs.reverse().map((l) => ({
    id: Number(l.id),
    stepSeq: l.step_seq,
    level: l.level as LogLevel,
    message: l.message,
    data: l.data,
    ts: l.ts.toISOString(),
  }));
  const oldestId = logs.length > 0 ? logs[0]!.id : null;
  const logsNextCursor = logsTruncated && oldestId !== null ? oldestId : null;

  return { run, steps, stepsTruncated, waits, waitsTruncated, logs, logsNextCursor };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a run until it reaches a terminal state. On timeout the latest
 * (non-terminal) status is returned without output/error.
 */
export async function waitForResult(
  pool: Pool,
  runId: string,
  namespace: Namespace,
  opts: WaitForResultOptions = {},
): Promise<WaitResult> {
  assertNamespace(namespace);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const res = await pool.query<{ status: string; output: unknown; error: unknown }>(
      `SELECT status, output, error FROM runs
        WHERE id = $1 AND project_id = $2 AND env = $3`,
      [runId, namespace.projectId, namespace.env],
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
