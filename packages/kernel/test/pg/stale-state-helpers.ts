/* =============================================================================
   @better-trigger/kernel — fault-injection helpers for stale-state tests
   (todos/p2-39).

   The public kernel API can only ever commit consistent state (a queued run
   has a queue row, a waiting run has a pending wait and no queue row, a
   terminal run has neither). The stale-state guards this todo adds defend
   against rows that such invariants could never produce — historical
   migration residue, hand repairs, or a future path's bug. Those rows have to
   be SEEDED, which is what these helpers do: plain INSERTs into runs / queue
   / waits with whatever status/lock shape the scenario needs, including a
   queue row whose run does not exist at all (FK bypassed under
   session_replication_role = replica, the same trick the wait-graph suite
   uses). All of them are test-only — they import nothing from src.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Namespace } from '@better-trigger/core';

/** Insert a runs row directly (fault injection): any status, no queue row, no
 *  task/worker registration — exactly the desynced shapes the guards must
 *  tolerate. */
export async function seedRun(
  pool: Pool,
  run: { id: string; taskId: string; status: string },
  ns: Namespace,
): Promise<void> {
  await pool.query(
    `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'api', now(), now())`,
    [run.id, ns.projectId, ns.env, run.taskId, run.status],
  );
}

/** Insert a queue row directly. Defaults to an unlocked, immediately-available
 *  row; pass `lockedBy`/`leaseUntil` for an expired-claim shape. */
export async function seedQueueRow(
  pool: Pool,
  q: {
    runId: string;
    lockedBy?: string | null;
    leaseUntil?: Date | null;
  },
  ns: Namespace,
): Promise<void> {
  await pool.query(
    `INSERT INTO queue (run_id, project_id, env, available_at, locked_by, lease_until)
     VALUES ($1, $2, $3, now(), $4, $5)`,
    [q.runId, ns.projectId, ns.env, q.lockedBy ?? null, q.leaseUntil ?? null],
  );
}

/** Insert a waits row directly (fault injection): any kind/status/resume_at. */
export async function seedWait(
  pool: Pool,
  w: {
    runId: string;
    stepSeq?: number;
    kind?: 'duration' | 'until' | 'run';
    resumeAt?: Date | null;
    status?: 'pending' | 'completed' | 'canceled';
  },
  ns: Namespace,
): Promise<void> {
  await pool.query(
    `INSERT INTO waits (run_id, project_id, env, step_seq, kind, resume_at, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      w.runId,
      ns.projectId,
      ns.env,
      w.stepSeq ?? 0,
      w.kind ?? 'duration',
      w.resumeAt ?? null,
      w.status ?? 'pending',
    ],
  );
}

/** Insert a queue row whose run_id has NO runs row. The FK normally forbids
 *  that; session_replication_role = replica disables FK triggers (partial
 *  unique indexes stay enforced — same trick as the wait-graph suite). The
 *  role is RESET in a finally BEFORE the connection goes back to the pool:
 *  if the INSERT throws, the pooled connection must not leak the replica
 *  role, which would silently disable FK enforcement for every later test
 *  that happens to draw this connection. */
export async function seedGhostQueueRow(
  pool: Pool,
  runId: string,
  ns: Namespace,
): Promise<void> {
  const raw = await pool.connect();
  try {
    await raw.query(`SET session_replication_role = replica`);
    await raw.query(
      `INSERT INTO queue (run_id, project_id, env, available_at)
       VALUES ($1, $2, $3, now())`,
      [runId, ns.projectId, ns.env],
    );
  } finally {
    await raw.query(`RESET session_replication_role`).catch(() => {});
    raw.release();
  }
}
