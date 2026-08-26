// Terminal transitions (complete / fail / cancel / retry) and parent wakeup.

import type { Pool, PoolClient } from 'pg';
import {
  assertNamespace,
  computeBackoffMs,
  KernelError,
  safeSerializeJson,
  type Namespace,
  type RetryPolicy,
  type RetryRunOptions,
  type SerializedError,
} from '@better-trigger/core';
import { notifyTerminal, notifyWork } from './notify';
import { enqueue, removeFromQueue } from './queue';
import { createRunIn } from './runs-create';
import {
  assertOwnedRunning,
  isUniqueViolation,
  lockQueueRow,
  lockRunRow,
  runOutputMaxBytes,
  serializeErrorForStorage,
  stepOutputMaxBytes,
  STEP_OUTPUT_ENVELOPE_BYTES,
  throwSerializeFailure,
  withTx,
  type RunRow,
} from './runs-internal';
import { upsertStep } from './runs-steps';

/* ---------------------------------------------------------------------------
 * Terminal transitions: complete / fail / cancel, with parent wakeup
 * ------------------------------------------------------------------------- */

/**
 * If `childRunId` is awaited by pending 'run' waits, fill each parent step row
 * with { id, ok, output?, error? } and re-enqueue the parent. ALL pending
 * waiters are processed (p1-37), in stable `id ASC` order — a child shared by
 * several parents must resolve every one of them, not a luck-of-the-plan row.
 * Runs inside the caller's transaction (which holds the CHILD's locks — each
 * parent's rows are re-acquired here in canonical order: queue → runs → wait
 * row). Parent sets are disjoint (a run has at most one pending run-wait), so
 * two child-terminal txs walking their waiters cannot deadlock.
 *
 * Each parent's queued-transition carries the expected-status predicate and
 * checks the affected-row count: a parent that is already cancel/terminal when
 * its row is reached must NOT be resurrected to 'queued'.
 *
 * `namespace` is the CHILD's namespace; the wait rows live in the same one
 * because children inherit their parent's namespace (C2). The predicate lets
 * `waits_child_run_idx` (project_id, env, child_run_id) bind its leading
 * columns instead of full-scanning waits on every child completion.
 */
export async function wakeParentIfWaiting(
  client: PoolClient,
  childRunId: string,
  namespace: Namespace,
  result: { ok: boolean; output?: unknown; error?: SerializedError },
): Promise<void> {
  // Locate the parents' pending waits WITHOUT locking them — each wait row may
  // only be locked after its parent's queue + runs rows (lock order 1→2→3).
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
      WHERE child_run_id = $1 AND kind = 'run' AND status = 'pending'
        AND project_id = $2 AND env = $3
      ORDER BY id ASC`,
    [childRunId, namespace.projectId, namespace.env],
  );

  const stepOutput: { id: string; ok: boolean; output?: unknown; error?: SerializedError } =
    { id: childRunId, ok: result.ok };
  if (result.output !== undefined) stepOutput.output = result.output;
  if (result.error !== undefined) stepOutput.error = result.error;

  for (const wait of waitRes.rows) {
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
    if (!lockedWait.rows[0]) continue; // canceled/completed while ordering locks

    await client.query(
      `UPDATE waits SET status = 'completed' WHERE id = $1
         AND project_id = $2 AND env = $3`,
      [wait.id, parentNs.projectId, parentNs.env],
    );

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

    // Re-enqueue the parent — only if it is actually 'waiting' (p1-37): the
    // runs row above is locked, so this predicate is belt-and-braces, and the
    // affected-row count keeps a parent that went cancel/terminal on some
    // other path from being resurrected to 'queued'.
    if (parent && parent.status === 'waiting') {
      const flipped = await client.query(
        `UPDATE runs SET status = 'queued', updated_at = now()
          WHERE id = $1 AND project_id = $2 AND env = $3 AND status = 'waiting'`,
        [wait.run_id, parentNs.projectId, parentNs.env],
      );
      if (flipped.rowCount === 1) {
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
  // Unconditional (p1-37): whether a waiter exists is decided by the pending
  // 'run' waits ON this run, never by this run's own parent_run_id — a child
  // created without a global idempotency key still has a parent_run_id, but a
  // waiter could also exist without one (or vice versa), so the terminal
  // result event must not be gated on the lineage column. The probe is an
  // indexed no-op when nobody waits.
  await wakeParentIfWaiting(
    client,
    run.id,
    { projectId: run.project_id, env: run.env },
    { ok: false, error },
  );
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
    // Unconditional (p1-37): pending 'run' waits on this run are the only
    // evidence of a waiter — parent_run_id is lineage, not a waiter registry
    // (see terminalFail for the full reasoning).
    await wakeParentIfWaiting(client, args.runId, args.namespace, {
      ok: true,
      output: args.output,
    });
    // Terminal: result waiters wake. If a parent was woken inside the same tx,
    // it may also be claimable again — the extra `work` notification is
    // harmless when it was not (the claim scan just comes back empty).
    // Completing a run also releases its concurrency slot, so a run waiting on
    // that concurrency limit needs a wake even when there is no parent.
    await notifyTerminal(client, args.runId, args.namespace);
    if (run.parent_run_id || run.concurrency_key) await notifyWork(client);
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
      // actually got re-enqueued. Failing a run also releases its concurrency
      // slot, so a run waiting on that concurrency limit needs a wake even when
      // there is no parent.
      await notifyTerminal(client, args.runId, args.namespace);
      if (run.parent_run_id || run.concurrency_key) await notifyWork(client);
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
    // Unconditional (p1-37) — pending 'run' waits on this run decide whether a
    // parent wakes, never parent_run_id (see terminalFail).
    await wakeParentIfWaiting(client, runId, namespace, {
      ok: false,
      error: { message: 'child canceled' },
    });
    // Terminal: wake result waiters (and the claim loops if a parent may have
    // been re-enqueued — harmless when it was not). Canceling a run also
    // releases its concurrency slot, so a run waiting on that concurrency limit
    // needs a wake even when there is no parent. The already-terminal no-op
    // early return above never reaches this point.
    await notifyTerminal(client, runId, namespace);
    if (run.parent_run_id || run.concurrency_key) await notifyWork(client);
  });
}

export async function retryRun(
  pool: Pool,
  runId: string,
  namespace: Namespace,
  opts?: RetryRunOptions,
): Promise<{ runId: string }> {
  assertNamespace(namespace);
  const operationKey = opts?.operationKey;
  try {
    return await withTx(pool, async (client) => {
      // Canonical lock order (see file header): the (usually absent) source
      // queue row first, then the source runs row. Locking the runs row is the
      // serialization point for concurrent retries of the same source AND for
      // a cancel/complete racing in — the status read below is decided at the
      // lock, so a completed/running run can never be retried off a stale
      // read. (Locking alone cannot recognize a replayed request minutes
      // later — that is what the operation record below is for, p2-38.)
      await lockQueueRow(client, runId, namespace);
      const run = await lockRunRow(client, runId, namespace);
      if (!run) throw new KernelError('not_found', `run ${runId} not found`);
      if (!['failed', 'canceled'].includes(run.status)) {
        throw new KernelError('conflict', `run ${runId} is ${run.status}, not retryable`);
      }
      if (operationKey) {
        const existing = await client.query<{ retry_run_id: string }>(
          `SELECT retry_run_id FROM run_retry_operations
            WHERE project_id = $1 AND env = $2 AND source_run_id = $3 AND operation_key = $4
            FOR UPDATE`,
          [namespace.projectId, namespace.env, runId, operationKey],
        );
        // Idempotent replay: this operation already created its run (and
        // enqueued it) — hand the same id back and create nothing. The FOR
        // UPDATE here is belt-and-braces: same-key concurrent retries already
        // serialized on the source runs row above.
        if (existing.rows[0]) return { runId: existing.rows[0].retry_run_id };
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
        // requireTask: a task that is no longer registered must 404 here, not
        // enqueue a dead run nobody can ever claim.
        triggerType: 'retry',
        namespace,
        requireTask: true,
      });
      if (operationKey) {
        // The operation record is written after its run — the FK to runs is
        // not deferrable, and the run id only exists once createRunIn minted
        // it. Same-key writers cannot actually reach this INSERT concurrently:
        // validating the FK holds a KEY SHARE lock on the SOURCE runs row,
        // which conflicts with the FOR UPDATE taken at canonical position 2 —
        // so a second same-key writer blocks there and, once the first
        // commits, takes the committed-row replay branch above. The unique
        // index is therefore defense-in-depth, NOT the main race path: it can
        // only fire for a write that bypassed the FK entirely
        // (session_replication_role = replica — what the pg test suite uses
        // to exercise this branch) or a future schema change. If it does
        // fire, the loser rolls the whole tx back — the just-created run
        // included, so no unrecorded retry run survives — and the catch below
        // re-reads the winner's row.
        await client.query(
          `INSERT INTO run_retry_operations
             (project_id, env, source_run_id, operation_key, retry_run_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [namespace.projectId, namespace.env, runId, operationKey, created.runId],
        );
      }
      await notifyWork(client);
      return { runId: created.runId };
    });
  } catch (err) {
    if (operationKey && isUniqueViolation(err)) {
      // Defense-in-depth path (see the INSERT comment above): the violating
      // insert only surfaced once the winner committed, so its row is visible
      // to this fresh read outside the aborted transaction. Rows are 1:1 with
      // committed runs, so answering with it cannot return a run this loser
      // would otherwise have had to create.
      const winner = await pool.query<{ retry_run_id: string }>(
        `SELECT retry_run_id FROM run_retry_operations
          WHERE project_id = $1 AND env = $2 AND source_run_id = $3 AND operation_key = $4`,
        [namespace.projectId, namespace.env, runId, operationKey],
      );
      if (winner.rows[0]) return { runId: winner.rows[0].retry_run_id };
      // The winner's row vanished between the violation and the read-back
      // (its run was pruned). Do not leak the raw pg error — the caller gets
      // a stable conflict carrying the original message instead of a 500.
      const cause = err instanceof Error ? err.message : String(err);
      throw new KernelError(
        'conflict',
        `retry operation conflicted and its winner row is gone (${cause})`,
      );
    }
    throw err;
  }
}
