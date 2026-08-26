// Durable step writes: step rows, suspend, wait-for-child-run and the
// batch-trigger child fan-out.

import type { Pool, PoolClient } from 'pg';
import {
  assertNamespace,
  KernelError,
  NonDeterminismError,
  safeSerializeJson,
  type KernelErrorCode,
  type Namespace,
  type SerializedError,
  type StepKind,
  type TriggerItem,
  type TriggerOptions,
} from '@better-trigger/core';
import { stepFingerprint } from './fingerprint';
import type { WaitGraphCounters } from './kernel';
import { notifyWork } from './notify';
import { removeFromQueue } from './queue';
import { createRunIn, createRunsInBatch, prepareBatchItems } from './runs-create';
import {
  assertBatchSize,
  assertOwnedRunning,
  errorMaxBytes,
  serializeErrorForStorage,
  stepOutputMaxBytes,
  withTx,
} from './runs-internal';

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
 * queue row → { resumed: false }. The non-immediate path releases the run's
 * concurrency slot (p2-41) and notifies the claim loops when the run carried a
 * concurrency_key — see the notifyWork call below.
 */
export async function suspendRun(
  pool: Pool,
  args: SuspendRunArgs,
): Promise<{ resumed: boolean }> {
  assertNamespace(args.namespace);
  return withTx(pool, async (client) => {
    const run = await assertOwnedRunning(
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
      // The claim (queue row + lease) is kept and no slot was released — the
      // 'waiting' flip below never ran, so nothing became claimable: no `work`
      // notification (the non-immediate path below sends one, this path must
      // not — p2-41).
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
    // The suspend released this run's concurrency slot: the flip to 'waiting'
    // took it out of claimRuns' running-count, so a queued run sharing its
    // concurrency_key is now claimable — and the worker that will claim it may
    // be parked in the claim loop's idle backoff. The `work` notification
    // (p2-41; the tx's LAST statement, delivered only at COMMIT) wakes that
    // loop immediately instead of at the next 300ms→2s poll. Same rule as the
    // terminal paths (completeRun/failRun/cancelRun: `run.concurrency_key` →
    // notifyWork): a run with no concurrency_key never gated another run, so
    // it notifies nothing and the notification stays a slot-release wake, not
    // a per-suspend ping. The already-due early return above never reaches
    // this point (no slot was released there).
    if (run.concurrency_key !== null) await notifyWork(client);
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
  waitGraph?: WaitGraphCounters,
): Promise<{ childRunId: string }> {
  assertNamespace(args.namespace);
  // The durable wait carries no GLOBAL idempotency key (p1-37): the child's
  // identity is the parent's durable step — (parent run id, step_seq), the pair
  // the pending-wait unique index enforces. Accepting the ordinary trigger key
  // here would let several parents (or the parent itself — a self-loop) attach
  // to one shared child, which the wait graph cannot represent: the wake would
  // resolve at most one waiter and a global-key conflict returns no status, so
  // a parent could park on an already-terminal child forever. Reject up front,
  // before any tx: every new parent step creates a fresh child, so self/mutual
  // cycles are structurally unformable.
  //
  // NOTE this is a plain parameter error, NOT a cycle refusal — no graph edge
  // was ever in danger of forming, so it must not touch waitGraph.cycleRejected
  // (that counter is reserved for a real attach-time cycle defense firing, i.e.
  // the defensive id-collision refusal below).
  if (args.options?.idempotencyKey != null) {
    throw new KernelError(
      'bad_request',
      `idempotencyKey is not supported on triggerAndWait: the child's identity is ` +
        `the parent's durable step (a new parent run or step always creates a new ` +
        `child) — use trigger() when global idempotency is required`,
    );
  }
  try {
    return await withTx(pool, async (client) => {
      const parent = await assertOwnedRunning(
        client,
        args.runId,
        args.workerId,
        args.fencingToken,
        args.namespace,
      );

      // Idempotent on replay: a completed wait step at this seq means the child
      // already ran (the SDK should normally hit the snapshot, but guard
      // anyway), or a pending wait from an earlier pass already created it.
      const existing = await readExistingChildRunId(client, args);
      if (existing) return { childRunId: existing };

      // requireTask: a typo'd taskId must fail HERE with TaskNotFoundError — the
      // parent run is suspended to 'waiting' right below, so an unregistered task
      // would otherwise strand it forever with a child run nobody claims.
      const child = await createRunIn(client, {
        taskId: args.taskId,
        payload: args.payload,
        options: args.options,
        triggerType: 'subtask',
        parentRunId: args.runId,
        namespace: { projectId: parent.project_id, env: parent.env },
        requireTask: true,
      });

      // Graph invariant (defensive, p1-37): the child is a fresh run id, so a
      // self-loop could only form via an id collision. Under the no-global-key
      // contract the public API can never build a cycle; this turns the
      // impossible case into a loud refusal instead of a database-level cycle.
      if (child.runId === args.runId) {
        if (waitGraph) waitGraph.cycleRejected += 1;
        throw new KernelError(
          'conflict',
          `child run id ${child.runId} collides with parent run id — the wait graph would self-loop`,
        );
      }

      // The wait INSERT is the same-step serialization point: the pending-step
      // unique index (project_id, env, run_id, step_seq, kind) WHERE
      // status='pending' absorbs a concurrent replay of THIS step. ON CONFLICT
      // DO NOTHING blocks until the winner's tx settles — a committed winner
      // yields no row, and the loser must roll back (the child created above
      // would otherwise be an unawaited orphan run) and re-read the winner's
      // committed wait/step instead of duplicating the parent→child edge.
      const inserted = await client.query(
        `INSERT INTO waits (run_id, project_id, env, step_seq, kind, child_run_id, fingerprint, status, created_at)
         VALUES ($1,$2,$3,$4,'run',$5,$6,'pending', now())
         ON CONFLICT (project_id, env, run_id, step_seq, kind) WHERE status = 'pending' DO NOTHING
         RETURNING id`,
        [
          args.runId,
          args.namespace.projectId,
          args.namespace.env,
          args.seq,
          child.runId,
          args.fingerprint ?? null,
        ],
      );
      if (inserted.rows.length === 0) {
        throw new PendingWaitConflictError(args.runId, args.seq);
      }
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
  } catch (err) {
    if (!(err instanceof PendingWaitConflictError)) throw err;
    // Lost the same-(parent, step) race and rolled back (child included). The
    // winner is COMMITTED — the conflict only resolves at the winner's COMMIT —
    // so the pending wait, or the completed step row if the child has already
    // gone terminal in between, is now visible. Read-only pass, deliberately
    // WITHOUT fencing: the winner suspended the parent to 'waiting', so
    // assertOwnedRunning would refuse; the rows read are this run's own
    // durable state, keyed on (run, seq, kind).
    return await withTx(pool, async (client) => {
      const existing = await readExistingChildRunId(client, args);
      if (existing === null) {
        // Defensive: the winner committed, so one of the two reads above must
        // have seen it. A vanish here means the rows were deleted by hand.
        throw new KernelError(
          'internal',
          `waitForChildRun: no wait or step row for run ${args.runId} seq ${args.seq} ` +
            `after a same-step conflict (rows deleted?)`,
        );
      }
      return { childRunId: existing };
    });
  }
}

/**
 * The replay/idempotency read shared by waitForChildRun's first pass and its
 * post-conflict re-read: the completed step row's recorded child id, then the
 * pending wait's child id. Null when this (run, seq) has neither yet.
 */
async function readExistingChildRunId(
  client: PoolClient,
  args: WaitForChildRunArgs,
): Promise<string | null> {
  const existingStep = await client.query<{ output: unknown }>(
    `SELECT output FROM run_steps
      WHERE run_id = $1 AND project_id = $2 AND env = $3 AND seq = $4 AND status = 'completed'`,
    [args.runId, args.namespace.projectId, args.namespace.env, args.seq],
  );
  if (existingStep.rows[0]) {
    const out = existingStep.rows[0].output as { id?: string } | null;
    if (out?.id) return out.id;
  }
  // Or a pending wait already created the child.
  const existingWait = await client.query<{ child_run_id: string | null }>(
    `SELECT child_run_id FROM waits
      WHERE run_id = $1 AND project_id = $2 AND env = $3
        AND step_seq = $4 AND kind = 'run' AND status = 'pending'`,
    [args.runId, args.namespace.projectId, args.namespace.env, args.seq],
  );
  if (existingWait.rows[0]?.child_run_id) {
    return existingWait.rows[0].child_run_id;
  }
  return null;
}

/**
 * Internal sentinel: the wait INSERT lost the pending-step unique race to a
 * concurrent replay of the SAME (run, step_seq). Never crosses the API
 * boundary — waitForChildRun catches it, rolls the whole tx back (the child
 * run created this pass included) and re-reads the winner's committed rows.
 */
class PendingWaitConflictError extends Error {
  constructor(
    runId: string,
    stepSeq: number,
  ) {
    super(`concurrent waitForChildRun replay at run ${runId} step ${stepSeq}`);
    this.name = 'PendingWaitConflictError';
  }
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
  // PF5: validate + serialize the whole batch BEFORE the transaction opens, so
  // a refused payload costs zero SQL here too (a serialization failure is a
  // pure in-memory verdict; nothing needs to be fenced to refuse it). The
  // fencing and step-idempotency checks stay inside the tx.
  const prepared = prepareBatchItems(args.items);
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

    // Batched creation (PF5): a constant number of statements for the whole
    // fan-out. Like createRunIn here, a missing task row is NOT an error —
    // "no task config" means default retry/concurrency.
    const out = await createRunsInBatch(client, {
      items: prepared,
      namespace: { projectId: parent.project_id, env: parent.env },
      triggerType: 'subtask',
      parentRunId: args.runId,
      requireTask: false,
    });
    const runIds = out.runIds;

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
