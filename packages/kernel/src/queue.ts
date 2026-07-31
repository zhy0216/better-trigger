/* =============================================================================
   @better-trigger/kernel — kernel queue engine.
   Enqueue / SKIP-LOCKED claim (with per-task concurrency limiting + lease and
   fencing token) / lease renewal / claim release on shutdown.
   See docs/backend-contract.md §3.5.
   Implemented with raw SQL over a single pg connection/transaction so the
   SELECT ... FOR UPDATE SKIP LOCKED semantics are exact. The pool is injected
   by createKernel() — no module-global connection.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import type { ClaimedRun, StepSnapshot } from '@better-trigger/core';

export interface EnqueueArgs {
  runId: string;
  availableAt: Date;
  priority?: number;
  concurrencyKey: string | null;
  projectId?: string;
  env?: string;
}

/**
 * Insert (or move-back) a run into the queue. Idempotent on run_id.
 * The conflict path clears locked_by/locked_at/lease_until (NULL lease =
 * unoccupied). The fencing token lives on the runs row — queue rows are
 * deleted and re-inserted across suspend/resume, so the watermark must not
 * (and does not) travel with them.
 */
export async function enqueue(client: PoolClient, args: EnqueueArgs): Promise<void> {
  await client.query(
    `INSERT INTO queue (run_id, available_at, priority, concurrency_key, project_id, env, locked_by, locked_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)
     ON CONFLICT (run_id) DO UPDATE
       SET available_at = EXCLUDED.available_at,
           priority     = EXCLUDED.priority,
           concurrency_key = EXCLUDED.concurrency_key,
           locked_by    = NULL,
           locked_at    = NULL,
           lease_until  = NULL`,
    [
      args.runId,
      args.availableAt,
      args.priority ?? 0,
      args.concurrencyKey,
      args.projectId ?? 'default',
      args.env ?? 'prod',
    ],
  );
}

/** Remove a run's queue row (used on suspend / terminal). */
export async function removeFromQueue(
  db: Pool | PoolClient,
  runId: string,
): Promise<void> {
  await db.query(`DELETE FROM queue WHERE run_id = $1`, [runId]);
}

export interface ClaimRunsArgs {
  workerId: string;
  /** Task ids this worker can execute (filtered in SQL). */
  taskIds: string[];
  /** Maximum runs to claim in this call. */
  limit: number;
  /** Lease duration granted per claimed run (renewed by heartbeat). */
  leaseMs: number;
}

/**
 * Claim up to `limit` runs for the given worker. Single transaction:
 *   SELECT candidates FOR UPDATE SKIP LOCKED (available + unclaimed, by
 *   priority, task set filtered in SQL), for each candidate skip if the
 *   concurrency limit is hit, otherwise claim it: take the lease on the queue
 *   row (locked_by/locked_at + lease_until = now() + leaseMs), then flip the
 *   run to running and bump runs.fencing_token — queue row locked before the
 *   runs row, the canonical kernel lock order (see runs.ts header). Returns
 *   claimed runs + step snapshots + the fencing token guarding each claim's
 *   writes. Expired-lease recovery is the reaper's job alone — candidates here
 *   stay `locked_by IS NULL`.
 */
export async function claimRuns(pool: Pool, args: ClaimRunsArgs): Promise<ClaimedRun[]> {
  if (args.taskIds.length === 0 || args.limit <= 0) return [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const candidates = await client.query<{
      id: number;
      run_id: string;
      concurrency_key: string | null;
    }>(
      `SELECT q.id, q.run_id, q.concurrency_key
         FROM queue q
         JOIN runs r ON r.id = q.run_id
        WHERE q.available_at <= now() AND q.locked_by IS NULL
          AND r.task_id = ANY($1::text[])
        ORDER BY q.priority DESC, q.id ASC
        LIMIT 10
        FOR UPDATE OF q SKIP LOCKED`,
      [args.taskIds],
    );

    const claimed: ClaimedRun[] = [];
    for (const cand of candidates.rows) {
      if (claimed.length >= args.limit) break;

      const runRes = await client.query<{
        id: string;
        task_id: string;
        payload: unknown;
        attempt: number;
        max_attempts: number;
        code_version: string | null;
        env: string;
        concurrency_key: string | null;
      }>(
        `SELECT id, task_id, payload, attempt, max_attempts, code_version, env, concurrency_key
           FROM runs WHERE id = $1`,
        [cand.run_id],
      );
      const run = runRes.rows[0];
      if (!run) continue;

      // Concurrency limit: read the task's limit; if set, count running runs
      // sharing the same concurrency_key (redundantly stored on runs).
      const taskRes = await client.query<{ concurrency_limit: number | null }>(
        `SELECT concurrency_limit FROM tasks WHERE id = $1`,
        [run.task_id],
      );
      const limit = taskRes.rows[0]?.concurrency_limit ?? null;
      if (limit != null && limit > 0) {
        const key = run.concurrency_key ?? run.task_id;
        // Serialize concurrent claims sharing this key: SKIP LOCKED does not
        // serialize two workers picking different queue rows of the same key, so
        // the count-then-flip below could race and overshoot the limit. Take a
        // tx-level advisory lock on the key first; it releases at COMMIT/ROLLBACK
        // and must be held while we count (same transaction).
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `bt:cc:${key}`,
        ]);
        const countRes = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM runs
            WHERE status = 'running' AND concurrency_key = $1`,
          [key],
        );
        const running = Number(countRes.rows[0]?.n ?? '0');
        if (running >= limit) continue; // leave it in the queue
      }

      // Claim it: take the lease on the (already SKIP LOCKED-held) queue row,
      // then bump the run's fencing token while flipping it to running. The
      // returned token is the claim's write credential — any later claim
      // invalidates it, and it survives suspend/resume because it lives on
      // runs, not on the delete-and-reinserted queue row.
      await client.query(
        `UPDATE queue
            SET locked_by = $1,
                locked_at = now(),
                lease_until = now() + ($2::text || ' milliseconds')::interval
          WHERE id = $3`,
        [args.workerId, String(args.leaseMs), cand.id],
      );

      const tokenRes = await client.query<{ fencing_token: string }>(
        `UPDATE runs
            SET status = 'running',
                started_at = COALESCE(started_at, now()),
                updated_at = now(),
                fencing_token = fencing_token + 1
          WHERE id = $1
          RETURNING fencing_token`,
        [run.id],
      );
      const fencingToken = Number(tokenRes.rows[0]?.fencing_token ?? 0);

      const stepsRes = await client.query<{
        seq: number;
        kind: string;
        label: string | null;
        status: string;
        output: unknown;
        error: unknown;
      }>(
        `SELECT seq, kind, label, status, output, error
           FROM run_steps WHERE run_id = $1 ORDER BY seq ASC`,
        [run.id],
      );
      const steps: StepSnapshot[] = stepsRes.rows.map((s) => ({
        seq: s.seq,
        kind: s.kind as StepSnapshot['kind'],
        label: s.label,
        status: s.status as StepSnapshot['status'],
        output: s.output ?? undefined,
        error: (s.error as StepSnapshot['error']) ?? undefined,
      }));

      claimed.push({
        id: run.id,
        taskId: run.task_id,
        payload: run.payload,
        attempt: run.attempt,
        maxAttempts: run.max_attempts,
        codeVersion: run.code_version,
        env: run.env,
        steps,
        fencingToken,
      });
    }

    await client.query('COMMIT');
    return claimed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface HeartbeatArgs {
  workerId: string;
  /** Runs currently executing on this worker (leases get renewed). */
  runIds: string[];
  /** Lease duration to extend to (lease_until = now() + leaseMs). */
  leaseMs: number;
}

export interface HeartbeatResult {
  /** Runs canceled server-side — the worker stops them (ctx.signal aborts). */
  cancelRunIds: string[];
  /**
   * Runs this worker asked to renew but no longer holds the claim on
   * (todos/01-correctness.md C2). Disjoint from cancelRunIds: a cancel is the
   * more specific answer for the same run and wins.
   */
  lostRunIds: string[];
}

/**
 * Renew leases for the given runs owned by this worker (heartbeat).
 * locked_at keeps its claim-time semantics and is not refreshed.
 * Returns the run ids that have been canceled (so the worker can stop them)
 * plus the ones whose claim is gone (so it can stop those too).
 *
 * `lostRunIds` costs nothing extra: the renewal is already scoped by
 * `locked_by = us`, so `RETURNING run_id` turns the statement the heartbeat
 * had to issue anyway into the answer to "which of these am I still the owner
 * of" — requested minus renewed is the loss set, same two round trips as before.
 *
 * It deliberately does NOT distinguish *why* a renewal missed. Both causes —
 * the lease was reaped and handed to another daemon, or the queue row is gone
 * because the run reached a terminal/waiting state through some other path —
 * mean the same thing to the caller: nothing this executor computes from here
 * on can legally be written (assertOwnedRunning checks queue.locked_by), so
 * carrying on is pure waste. The reaction is a local abort, never a kernel
 * write, so a false positive can cost at most an execution that was already
 * void. Telling the two apart would need a third query for no change in
 * behaviour.
 */
export async function heartbeat(
  pool: Pool,
  args: HeartbeatArgs,
): Promise<HeartbeatResult> {
  // Extend leases for runs still owned by this worker; the rows that come back
  // are exactly the claims we still hold.
  let renewed: string[] = [];
  if (args.runIds.length > 0) {
    const res = await pool.query<{ run_id: string }>(
      `UPDATE queue SET lease_until = now() + ($1::text || ' milliseconds')::interval
        WHERE locked_by = $2 AND run_id = ANY($3::text[])
        RETURNING run_id`,
      [String(args.leaseMs), args.workerId, args.runIds],
    );
    renewed = res.rows.map((r) => r.run_id);
  }
  await pool.query(
    `UPDATE workers SET last_heartbeat_at = now(), status = 'online' WHERE id = $1`,
    [args.workerId],
  );

  if (args.runIds.length === 0) return { cancelRunIds: [], lostRunIds: [] };
  // Any of the heartbeat's runs that are no longer 'running' → tell worker to drop.
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM runs
      WHERE id = ANY($1::text[]) AND status = 'canceled'`,
    [args.runIds],
  );
  const cancelRunIds = res.rows.map((r) => r.id);

  const held = new Set(renewed);
  const canceled = new Set(cancelRunIds);
  const lostRunIds = args.runIds.filter((id) => !held.has(id) && !canceled.has(id));
  return { cancelRunIds, lostRunIds };
}

export interface ReleaseClaimsArgs {
  /** Only this worker's claims are released — never another worker's. */
  workerId: string;
}

export interface ReleaseClaimsResult {
  /** Runs handed back, for the caller to log. Empty when nothing was held. */
  releasedRunIds: string[];
}

/**
 * Hand every claim this worker still holds back to the queue — the graceful
 * shutdown counterpart of the lease reaper (todos/01-correctness.md C3).
 *
 * A stopping daemon that just exits leaves its undrained runs with locked_by
 * set and a lease that is still valid, so nothing may touch them until the
 * lease expires (60s) and the reaper's next tick notices — and the reaper's
 * recovery path spends one of the run's `recoveries` (C4), which turns a clean
 * `docker compose restart` into a charge against the budget that exists for
 * machines dying. This releases them instead:
 *
 *   - Neither counter moves: `runs.attempt` (the user's code failing) and
 *     `runs.recoveries` (infrastructure taking a run away) are both left
 *     alone. A stop is a handover — nothing failed and nothing was recovered;
 *     the run picks up where its ledger left off on its next claim.
 *   - `runs.fencing_token` is NOT bumped either (only claimRuns ever bumps it),
 *     and it does not need to be: assertOwnedRunning also requires
 *     queue.locked_by to be this worker, so dropping the claim makes a late
 *     write from an executor that ignored the drain *illegal immediately*
 *     rather than legal until the reaper — releasing a claim can never widen
 *     the window in which stale writes are accepted. The next claim's token++
 *     invalidates them for good.
 *   - `runs.status` goes back to 'queued', exactly as failRun's retry branch
 *     and the reaper do. Not cosmetic: a run left 'running' would be counted
 *     against its own concurrency_key by claimRuns' limit check, and a task at
 *     concurrency_limit 1 could never reclaim it.
 *   - `available_at = now()` so the next worker picks it up on its next poll
 *     instead of after the lease.
 *
 * Idempotent: a second call matches no rows (concurrent shutdown paths, a
 * signal landing during a crash drain). Lock order is canonical — the queue
 * rows are locked first, each run's row second (see runs.ts header).
 */
export async function releaseClaims(
  pool: Pool,
  args: ReleaseClaimsArgs,
): Promise<ReleaseClaimsResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Canonical lock position 1. Deliberately NOT `SKIP LOCKED`: a row of ours
    // held by another transaction is one being reaped or completed right now,
    // and waiting for it costs a moment on a path that has nothing else to do.
    // ORDER BY keeps the acquisition order deterministic.
    const held = await client.query<{ run_id: string }>(
      `SELECT run_id FROM queue WHERE locked_by = $1 ORDER BY run_id FOR UPDATE`,
      [args.workerId],
    );
    const runIds = held.rows.map((r) => r.run_id);
    if (runIds.length === 0) {
      await client.query('COMMIT');
      return { releasedRunIds: [] };
    }

    // Canonical lock position 2, one run at a time. `status = 'running'` scopes
    // it to runs this worker was actually executing; anything else (a run that
    // reached a terminal state between the two statements) keeps its own state.
    for (const runId of runIds) {
      await client.query(
        `UPDATE runs SET status = 'queued', updated_at = now()
          WHERE id = $1 AND status = 'running'`,
        [runId],
      );
    }

    // The release itself. `locked_by = $1` is re-checked so this can only ever
    // clear this worker's own claims, whatever else raced in between.
    const released = await client.query<{ run_id: string }>(
      `UPDATE queue
          SET locked_by = NULL, locked_at = NULL, lease_until = NULL, available_at = now()
        WHERE locked_by = $1 AND run_id = ANY($2::text[])
        RETURNING run_id`,
      [args.workerId, runIds],
    );

    await client.query('COMMIT');
    return { releasedRunIds: released.rows.map((r) => r.run_id) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
