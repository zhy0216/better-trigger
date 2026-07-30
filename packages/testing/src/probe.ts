/* =============================================================================
   @better-trigger/testing — direct-SQL probes.

   Small reads the scenarios need but the HTTP surface does not offer, factored
   out because more than one scenario waits on each of them:

     waitForTasks()          a spawned executor has finished registering — the
                             gate every daemon-driven scenario opens with, since
                             triggering before registration just queues nothing.
     countQueueRows()        "does this run still hold a claim?" — the shape
                             both the crash and the fencing scenario assert on.
     readLatestCodeVersion() tasks.latest_code_version, i.e. which deploy last
                             registered this task.

   These read the ledger, not the API, for the same reason invariants.ts does:
   they are questions about the database's state, and the daemon under test may
   be dead at the moment they are asked.
   ============================================================================= */
import type { Pool } from 'pg';
import { waitFor } from './poll';

/**
 * Wait until every `taskIds` entry exists in `tasks`. Query errors count as
 * "not yet": the executor may still be migrating or booting.
 */
export async function waitForTasks(
  pool: Pool,
  taskIds: string[],
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await waitFor(`tasks ${taskIds.join(' + ')} to be registered`, opts.timeoutMs ?? 30_000, async () => {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE id = ANY($1::text[])`,
      [taskIds],
    );
    return res.rows[0].n === taskIds.length;
  });
}

/** How many queue rows this run holds (0 = no worker owns it right now). */
export async function countQueueRows(pool: Pool, runId: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM queue WHERE run_id = $1`,
    [runId],
  );
  return res.rows[0].n;
}

/** `tasks.latest_code_version` for a task, or null when it is unregistered. */
export async function readLatestCodeVersion(pool: Pool, taskId: string): Promise<string | null> {
  const res = await pool.query<{ v: string | null }>(
    `SELECT latest_code_version AS v FROM tasks WHERE id = $1`,
    [taskId],
  );
  return res.rows[0]?.v ?? null;
}
