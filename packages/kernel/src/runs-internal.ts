// Shared internals of the kernel run lifecycle: lock-order docs, config caps,
// pure helpers and the row-lock helpers every run module builds on.
/* =============================================================================
   @better-trigger/kernel — kernel run lifecycle.
   Create (idempotent) / steps / suspend / wait-for-child / batch-trigger /
   complete / fail / cancel / retry, plus parent-wakeup for child runs, run
   reads (getRun / getRunDetail / waitForResult) and strictly-bounded logs
   (appendLogs: best-effort in the sense that lines may be dropped, but a
   terminal run never absorbs a line committed after its finished_at).
   See docs/backend-contract.md §3.2–3.7. All multi-row mutations are wrapped
   in a single transaction via withTx().

   LOCK ORDER (canonical — every multi-row kernel tx acquires in this order):
     1. queue row  — SELECT ... FROM queue WHERE run_id = $1 FOR UPDATE (0/1 rows)
     2. runs row   — SELECT ... FROM runs  WHERE id     = $1 FOR UPDATE
     3. dependent rows of that run (waits / run_steps; a manual retry with an
        operation key also locks the source's run_retry_operations row here —
        position 3+, same-key writers already serialized at position 2, p2-38)
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

   LOG BOUNDARY (p2-40): appendLogs is the deliberate exception to the
   canonical order — a per-chunk, single-row tx that takes ONLY position 2
   (the runs row, FOR UPDATE, never the queue row) and then either inserts the
   chunk (finished_at IS NULL) or drops it. Skipping position 1 is required:
   a waiting/suspended run has no queue row but must still absorb logs. The
   lock is held for exactly one INSERT (not the whole flush), and because the
   tx takes no other TABLE row lock it can neither close a cycle with a 1→2 tx
   (it never waits on a queue row) nor lengthen a terminal tx's own hold: the
   terminal side only ever waits behind a single in-flight log INSERT. (The
   logs INSERT does acquire logs heap/index page locks; page-level cycles with
   prune's cascade deletes are resolved by PG's deadlock detector, and the
   losing flush fails as a dropped best-effort chunk.)
   ============================================================================= */

import type { Pool, PoolClient } from 'pg';
import {
  KernelError,
  parseDuration,
  RunNotRunningError,
  safeSerializeJson,
  StaleLeaseError,
  type KernelErrorCode,
  type Namespace,
  type SerializedError,
  type TriggerItem,
  type TriggerOptions,
} from '@better-trigger/core';

/** Upper bound for a delay before a run becomes available: 10 years in ms. */
const MAX_DELAY_MS = 315_576_000_000;

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
/** Total serialized payload cap for ONE batchTrigger transaction (PF5): the
 *  per-item cap bounds one run, but 500 items at 256 KiB each would still park
 *  128 MiB of jsonb in a single write tx — so the batch as a whole has its own
 *  ceiling, a fraction of the theoretical max. The body cap (1 MiB) already
 *  bounds what an HTTP caller can send, but child fan-outs (batchTriggerChild)
 *  never cross HTTP, so the kernel must enforce it itself. */
const DEFAULT_MAX_BATCH_PAYLOAD_BYTES = 1024 * 1024;

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
export const STEP_OUTPUT_ENVELOPE_BYTES = 128;

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
/** Max TOTAL serialized payload bytes across one batchTrigger's items
 *  (BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES). */
export const maxBatchPayloadBytes = () =>
  envLimit('BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES', DEFAULT_MAX_BATCH_PAYLOAD_BYTES);
/** Max serialized step output/error (BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES). */
export const stepOutputMaxBytes = () =>
  envLimit('BETTER_TRIGGER_STEP_OUTPUT_MAX_BYTES', DEFAULT_STEP_OUTPUT_MAX_BYTES);
/** Max serialized run output (BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES). */
export const runOutputMaxBytes = () =>
  envLimit('BETTER_TRIGGER_RUN_OUTPUT_MAX_BYTES', DEFAULT_RUN_OUTPUT_MAX_BYTES);
/** Max serialized error record (BETTER_TRIGGER_ERROR_MAX_BYTES). */
export const errorMaxBytes = () => envLimit('BETTER_TRIGGER_ERROR_MAX_BYTES', DEFAULT_ERROR_MAX_BYTES);
/** Max serialized `data` on one log line (BETTER_TRIGGER_LOG_DATA_MAX_BYTES). */
export const logDataMaxBytes = () =>
  envLimit('BETTER_TRIGGER_LOG_DATA_MAX_BYTES', DEFAULT_LOG_DATA_MAX_BYTES);
/** Max serialized message on one log line (BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES). */
export const logMessageMaxBytes = () =>
  envLimit('BETTER_TRIGGER_LOG_MESSAGE_MAX_BYTES', DEFAULT_LOG_MESSAGE_MAX_BYTES);
/** Max serialized payload of one log INSERT (BETTER_TRIGGER_LOG_BATCH_MAX_BYTES). */
export const logBatchMaxBytes = () =>
  envLimit('BETTER_TRIGGER_LOG_BATCH_MAX_BYTES', DEFAULT_LOG_BATCH_MAX_BYTES);

/**
 * Reaper recovery budget stamped on new runs (BETTER_TRIGGER_MAX_RECOVERIES).
 * Read with its own parser rather than envLimit: 0 is a meaningful setting here
 * ("never recover a lost run, fail it the moment its lease expires") whereas
 * envLimit treats 0 as garbage and falls back to the default.
 */
export function maxRecoveries(): number {
  const raw = process.env.BETTER_TRIGGER_MAX_RECOVERIES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_RECOVERIES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MAX_RECOVERIES;
}

/** Shared by both batch entry points; checked before any tx is opened. */
export function assertBatchSize(items: TriggerItem[]): void {
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
export function throwSerializeFailure(res: { ok: false; code: KernelErrorCode; message: string }): never {
  throw new KernelError(res.code, res.message);
}

/** The options every create path shares, normalized to the values the INSERTs
 *  need. Shared by createRunIn and the batch paths (PF5) so a single trigger
 *  and a fan-out cannot drift apart in what they accept. */
export interface ParsedRunOptions {
  priority: number;
  idempotencyKey: string | null;
  concurrencyKey: string | null;
  availableAt: Date;
}

/**
 * Validate + normalize trigger options, throwing KernelError('bad_request') on
 * garbage. Pure (no SQL): the batch paths run it for every item before any
 * statement, so a refused batch costs zero round trips (PF5).
 */
export function parseCreateRunOptions(
  options: TriggerOptions | null | undefined,
): ParsedRunOptions {
  // A non-object `options` (a JSON string, an array) would otherwise have every
  // key read as undefined — the run silently loses the caller's intent.
  if (options != null && (typeof options !== 'object' || Array.isArray(options))) {
    throw new KernelError('bad_request', 'options must be an object');
  }
  const opts = options ?? {};

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

  return {
    priority,
    idempotencyKey: opts.idempotencyKey ?? null,
    concurrencyKey: opts.concurrencyKey ?? null,
    availableAt,
  };
}

/**
 * Serialize a payload for storage, throwing the stable KernelError family on
 * failure — never a raw TypeError that would read as a 500 (C3).
 */
export function serializePayload(payload: unknown): { json: string; bytes: number } {
  const res = safeSerializeJson(payload ?? null, maxPayloadBytes(), 'payload');
  if (!res.ok) throwSerializeFailure(res);
  return { json: res.json, bytes: res.bytes };
}

/**
 * Serialize an error record (runs.error / run_steps.error) for storage,
 * degrading instead of failing the write: a run or step that cannot record
 * its own error must still transition — a failed failure-report would strand
 * the run in a reap/retry loop. On failure the stored record is a stable
 * SerializationError that names the problem.
 */
export function serializeErrorForStorage(error: SerializedError): string {
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

/** The name pg reports for run_retry_operations' PK unique violation. Migration
 *  0015 declares it as "run_retry_operations_..._operation_key_pk", but pg
 *  truncates identifiers to 63 bytes (NAMEDATALEN-1), so the live constraint
 *  name — what `err.constraint` actually carries — drops the "_pk" suffix.
 *  This is the ONLY unique violation retryRun's read-back may answer; every
 *  other 23505 — another table's unique index, or a future unique index added
 *  to this table — must surface as an error, not be silently re-read as if a
 *  retry operation had raced. */
export const RETRY_OPERATION_UNIQUE_CONSTRAINT =
  'run_retry_operations_project_id_env_source_run_id_operation_key';

/**
 * True when the error is the pg unique-violation (SQLSTATE 23505) of
 * run_retry_operations' own PK. Anything else is NOT a lost retry-operation
 * race and is left for the caller to see.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint?: unknown }).constraint === RETRY_OPERATION_UNIQUE_CONSTRAINT
  );
}

/** Canonical lock position 1: the run's queue row, 0 or 1 rows (see header). */
export async function lockQueueRow(
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
export async function assertOwnedRunning(
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
