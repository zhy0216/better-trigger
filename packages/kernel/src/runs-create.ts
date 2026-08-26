// Create paths: idempotent run creation, client trigger / batchTrigger and
// the shared batch-creation core (PF5).

import type { Pool, PoolClient } from 'pg';
import {
  assertNamespace,
  KernelError,
  resolveRetryPolicy,
  TaskNotFoundError,
  type CreatedRun,
  type Namespace,
  type RetryPolicy,
  type TriggerItem,
  type TriggerOptions,
  type TriggerType,
} from '@better-trigger/core';
import { runId as genRunId } from './ids';
import { notifyWork } from './notify';
import { enqueue, enqueueMany } from './queue';
import {
  assertBatchSize,
  maxBatchPayloadBytes,
  maxRecoveries,
  parseCreateRunOptions,
  serializePayload,
  withTx,
} from './runs-internal';

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
  const parsed = parseCreateRunOptions(args.options);

  // Serialize the payload once, up front: it is what actually reaches pg, so it
  // is what has to be measured, and doing it before the first query means an
  // oversized or unserializable body costs one canonicalization instead of a
  // round trip plus a row. (safeSerializeJson — not raw JSON.stringify: a
  // circular / BigInt payload would otherwise throw a TypeError that reads as
  // a 500, and an over-limit one must surface as payload_too_large, the same
  // family the HTTP body cap uses. `?? null` keeps the pre-existing meaning
  // of an undefined payload — it stores NULL.)
  const payloadJson = serializePayload(args.payload).json;

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
    ? parsed.concurrencyKey ?? args.taskId
    : parsed.concurrencyKey ?? null;
  // The namespace is explicit on the args — never defaulted here (C2).
  const { projectId, env } = args.namespace;
  // Resolved once and written to BOTH the runs row and the queue row: the queue
  // row is what the claim scan orders by, the runs copy is what outlives it
  // (the queue row is deleted at terminal / suspend), so a manual retry can
  // reproduce the run's scheduling config instead of silently dropping to 0.
  const priority = parsed.priority;
  const availableAt = parsed.availableAt;

  const id = genRunId();

  // Idempotency is enforced atomically by the partial unique index
  // (project_id, env, task_id, idempotency_key) WHERE idempotency_key IS NOT
  // NULL — namespace-scoped, so the same task + key in prod and staging creates
  // two independent runs (C2). INSERT ... ON CONFLICT DO NOTHING wins the race;
  // a loser gets no row back and reads the existing run. (Without a key there
  // is no conflict target, so insert plainly.)
  const insertSql = parsed.idempotencyKey !== null
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
    parsed.idempotencyKey,
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
      [projectId, env, args.taskId, parsed.idempotencyKey],
    );
    if (existing.rows[0]) {
      return { runId: existing.rows[0].id, idempotent: true };
    }
    // Defensive: a DO NOTHING with no surviving row should not happen.
    throw new KernelError('internal', 'failed to create run');
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
 *
 * The whole batch is validated and serialized BEFORE the transaction opens
 * (PF5), so a refused batch — a bad option, an over-cap payload, or a total
 * payload over the batch byte cap — costs zero SQL and not even a connection.
 * What survives is inserted in a constant number of statements regardless of
 * item count: one task-config preload, one multi-row runs INSERT, one conflict
 * readback (only when idempotency keys collide), one multi-row queue INSERT.
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
  // An empty batch is a no-op, not a query: return without opening a
  // transaction (an empty VALUES list would be a syntax error anyway, and a
  // 500-item tx that does nothing is pure waste).
  if (items.length === 0) return { runIds: [] };
  const prepared = prepareBatchItems(items);
  const runIds = await withTx(pool, async (client) => {
    const out = await createRunsInBatch(client, {
      items: prepared,
      namespace,
      triggerType: 'api',
      parentRunId: null,
      requireTask: true,
    });
    // One aggregate `work` notification for the whole batch (the payload is
    // run-id-less by design, so 500 items cost one NOTIFY, far under the
    // 8000-byte cap) — only when at least one NEW run was enqueued.
    if (out.createdAny) await notifyWork(client);
    return out.runIds;
  });
  return { runIds };
}

/* ---------------------------------------------------------------------------
 * Batch creation core (PF5)
 * ------------------------------------------------------------------------- */

/** One batch item, validated + serialized, ready for the INSERTs. */
export interface PreparedBatchItem {
  taskId: string;
  /** Serialized payload — the bytes that actually reach the jsonb column. */
  payloadJson: string;
  priority: number;
  idempotencyKey: string | null;
  /** The caller's concurrencyKey option; the task's default is applied later
   *  (it needs the preloaded task config). */
  concurrencyKey: string | null;
  availableAt: Date;
}

/**
 * Validate + serialize every item of a batch, and enforce the batch's TOTAL
 * serialized-payload cap on top of the per-item one. Pure (no SQL): a refusal
 * anywhere — a bad option, an unserializable / over-cap payload, a total over
 * the byte cap — costs zero round trips and, in the client path, not even a
 * connection (PF5).
 */
export function prepareBatchItems(items: TriggerItem[]): PreparedBatchItem[] {
  const cap = maxBatchPayloadBytes();
  let totalBytes = 0;
  const prepared: PreparedBatchItem[] = [];
  for (const item of items) {
    const parsed = parseCreateRunOptions(item.options);
    const payload = serializePayload(item.payload);
    totalBytes += payload.bytes;
    if (totalBytes > cap) {
      throw new KernelError(
        'bad_request',
        `items must serialize to at most ${cap} bytes in total ` +
          `(split larger fan-outs into batches)`,
      );
    }
    prepared.push({
      taskId: item.taskId,
      payloadJson: payload.json,
      priority: parsed.priority,
      idempotencyKey: parsed.idempotencyKey,
      concurrencyKey: parsed.concurrencyKey,
      availableAt: parsed.availableAt,
    });
  }
  return prepared;
}

/**
 * Create all runs of a prepared batch in the caller's transaction, in a
 * constant number of statements no matter how many items:
 *
 *   1. one task-config preload: `SELECT ... WHERE (project_id, env, id) IN
 *      (VALUES ...)` over the DEDUPLICATED task ids — repeated task ids (the
 *      same task fanning out N times) cost one row of the map, not N lookups;
 *   2. one multi-row `INSERT INTO runs ... ON CONFLICT (...) DO NOTHING
 *      RETURNING id` — run ids are generated client-side, so a RETURNING row
 *      missing an item's id means idempotency conflict;
 *   3. one batched readback `SELECT id ... IN (VALUES ...)` for exactly the
 *      conflicted (task_id, idempotency_key) pairs — conflicts are the rare
 *      case, and this statement only exists when there is at least one;
 *   4. one multi-row `INSERT INTO queue ... ON CONFLICT (run_id) DO UPDATE`
 *      for the newly created runs only (conflicts enqueue nothing, exactly
 *      like createRunIn).
 *
 * Per-item semantics are identical to createRunIn: priority / availableAt /
 * idempotencyKey / concurrencyKey (task default applied from the preload) /
 * triggerType / parentRunId are all per item, and a missing task throws
 * TaskNotFoundError (requireTask) — the whole tx rolls back, so the batch
 * stays all-or-nothing. No per-item advisory lock here: the concurrency limit
 * is enforced at claim time, this path only records concurrency_key.
 */
export async function createRunsInBatch(
  client: PoolClient,
  args: {
    items: PreparedBatchItem[];
    namespace: Namespace;
    triggerType: TriggerType;
    parentRunId: string | null;
    requireTask: boolean;
  },
): Promise<{ runIds: string[]; createdAny: boolean }> {
  const { projectId, env } = args.namespace;

  // Empty batch: nothing to insert. The client entry point refuses to open a
  // transaction at all; the child entry point (batchTriggerChild) still needs
  // the tx for its fencing + step row, so this guard only skips the batch SQL
  // itself — an empty VALUES list would be a syntax error.
  if (args.items.length === 0) return { runIds: [], createdAny: false };

  // 1. Task config, one preload over the deduplicated task ids.
  const taskIds = [...new Set(args.items.map((p) => p.taskId))];
  const preloadStart = 1;
  const preloadValues = taskIds
    .map(
      (_, i) =>
        `($${preloadStart + i * 3}::text, $${preloadStart + i * 3 + 1}::text, ` +
        `$${preloadStart + i * 3 + 2}::text)`,
    )
    .join(', ');
  const taskRes = await client.query<{
    id: string;
    retry: RetryPolicy | null;
    concurrency_limit: number | null;
    latest_code_version: string | null;
  }>(
    `SELECT id, retry, concurrency_limit, latest_code_version
       FROM tasks WHERE (project_id, env, id) IN (VALUES ${preloadValues})`,
    taskIds.flatMap((id) => [projectId, env, id]),
  );
  const tasks = new Map(taskRes.rows.map((t) => [t.id, t]));

  // 2. Resolve each item against its task and build the runs INSERT. The run id
  // is generated here, before the statement: RETURNING alone cannot say WHICH
  // VALUES row a returned id came from, and the idempotency readback below
  // needs per-item identity.
  const recoveries = maxRecoveries();
  interface ResolvedItem {
    runId: string;
    /** Copied from the batch item so the later stages never index two arrays. */
    taskId: string;
    /** Serialized payload from the batch item (goes into the runs INSERT). */
    payloadJson: string;
    concurrencyKey: string | null;
    policy: RetryPolicy;
    codeVersion: string | null;
    availableAt: Date;
    priority: number;
    idempotencyKey: string | null;
  }
  const resolved: ResolvedItem[] = args.items.map((p) => {
    const task = tasks.get(p.taskId);
    if (!task && args.requireTask) {
      throw new TaskNotFoundError(
        `task ${p.taskId} not registered in ${projectId}/${env}`,
      );
    }
    const hasLimit = (task?.concurrency_limit ?? 0) > 0;
    return {
      runId: genRunId(),
      taskId: p.taskId,
      payloadJson: p.payloadJson,
      concurrencyKey: hasLimit ? p.concurrencyKey ?? p.taskId : p.concurrencyKey ?? null,
      policy: resolveRetryPolicy(task?.retry ?? undefined),
      codeVersion: task?.latest_code_version ?? null,
      availableAt: p.availableAt,
      priority: p.priority,
      idempotencyKey: p.idempotencyKey,
    };
  });

  const rowStart = 1;
  const rowValues = resolved
    .map((_, i) => {
      const b = rowStart + i * 13;
      return `($${b},$${b + 1},$${b + 2},$${b + 3},'queued',$${b + 4},$${b + 5},$${b + 6},` +
        `$${b + 7},$${b + 8},$${b + 9},1,$${b + 10},0,$${b + 11},$${b + 12}, now(), now(), now())`;
    })
    .join(', ');
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO runs
       (id, project_id, env, task_id, status, payload, trigger_type, parent_run_id,
        idempotency_key, concurrency_key, priority, attempt, max_attempts,
        recoveries, max_recoveries, code_version,
        queued_at, created_at, updated_at)
     VALUES ${rowValues}
     ON CONFLICT (project_id, env, task_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    resolved.flatMap((r) => [
      r.runId,
      projectId,
      env,
      r.taskId,
      r.payloadJson,
      args.triggerType,
      args.parentRunId,
      r.idempotencyKey,
      r.concurrencyKey,
      r.priority,
      r.policy.maxAttempts,
      recoveries,
      r.codeVersion,
    ]),
  );

  // 3. Idempotency conflicts: a VALUES row whose id is missing from RETURNING
  // lost the INSERT race (or repeated a key present earlier IN THIS batch).
  // Re-read exactly those (task_id, idempotency_key) pairs in one statement.
  const insertedIds = new Set(inserted.rows.map((r) => r.id));
  const existingByIdKey = new Map<string, string>();
  const conflictPairs = resolved.flatMap((r) =>
    insertedIds.has(r.runId) ? [] : [{ taskId: r.taskId, key: r.idempotencyKey! }],
  );
  if (conflictPairs.length > 0) {
    const cb = 1;
    const conflictValues = conflictPairs
      .map(
        (_, i) =>
          `($${cb + i * 4}::text, $${cb + i * 4 + 1}::text, $${cb + i * 4 + 2}::text, ` +
          `$${cb + i * 4 + 3}::text)`,
      )
      .join(', ');
    const readback = await client.query<{
      id: string;
      task_id: string;
      idempotency_key: string;
    }>(
      `SELECT id, task_id, idempotency_key FROM runs
        WHERE (project_id, env, task_id, idempotency_key) IN (VALUES ${conflictValues})`,
      conflictPairs.flatMap((p) => [projectId, env, p.taskId, p.key]),
    );
    for (const row of readback.rows) {
      existingByIdKey.set(`${row.task_id}\u0000${row.idempotency_key}`, row.id);
    }
  }

  // 4. Enqueue only the newly created runs (conflicts enqueue nothing — the
  // original trigger already did).
  const runIds: string[] = [];
  const toEnqueue = [];
  let createdAny = false;
  for (const r of resolved) {
    if (insertedIds.has(r.runId)) {
      runIds.push(r.runId);
      createdAny = true;
      toEnqueue.push({
        runId: r.runId,
        availableAt: r.availableAt,
        priority: r.priority,
        concurrencyKey: r.concurrencyKey,
        namespace: args.namespace,
      });
    } else {
      const existingId = existingByIdKey.get(`${r.taskId}\u0000${r.idempotencyKey}`);
      if (!existingId) {
        // Defensive: a DO NOTHING with no surviving row should not happen.
        throw new KernelError('internal', 'failed to create run');
      }
      runIds.push(existingId);
    }
  }
  if (toEnqueue.length > 0) await enqueueMany(client, toEnqueue);

  return { runIds, createdAny };
}
