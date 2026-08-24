/* =============================================================================
   @better-trigger/kernel — version-pinned claims.

   Replay keys steps by position, so a run whose task was edited mid-flight has
   a ledger the new code may no longer line up with. `--pin-code-version` is the
   structural answer: the claim itself refuses runs this build cannot replay,
   instead of letting the executor discover the drift halfway through.

   What is pinned here:

     - unpinned (no `codeVersions`) is byte-for-byte the old statement — the
       default path must not acquire a version predicate by accident;
     - pinned filters IN SQL, not in the claim loop: a window full of
       other-version rows would otherwise report "nothing to claim" while
       claimable runs sat one row further down;
     - the pairs are per task, so task A at v2 and task B at v1 in one process
       is a claimable state, not a contradiction;
     - `code_version IS NULL` stays claimable (a run created before its task was
       ever registered has no version to honour);
     - locking is unchanged — `FOR UPDATE OF q` still names the queue row alone,
       CTE or no CTE;
     - arrays that are not parallel are refused rather than silently pinning one
       task to another's version.

   No Postgres: a stub client replays canned rows per statement shape and
   records everything sent. The SQL itself is exercised against a real server by
   the acceptance suite.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError } from '@better-trigger/core';
import { claimRuns } from '../src/queue';

interface Stmt {
  sql: string;
  params: unknown[];
}

function stubPool(rows: unknown[] = []) {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM queue q/.test(sql)) return { rows };
      if (/FROM run_steps/.test(sql)) return { rows: [] };
      if (/RETURNING fencing_token/.test(sql)) return { rows: [{ fencing_token: '1' }], rowCount: 1 };
      return { rows: [] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, stmts };
}

const ARGS = {
  workerId: 'w1',
  namespaces: [DEFAULT_NAMESPACE],
  taskIds: ['send-email', 'sync-crm'],
  leaseMs: 60_000,
  limit: 1,
};
const candidateOf = (stmts: Stmt[]) => stmts.find((s) => /FROM queue q/.test(s.sql))!;

describe('claimRuns without pinning', () => {
  it('sends no version predicate at all', async () => {
    const { pool, stmts } = stubPool();

    await claimRuns(pool, ARGS);

    const cand = candidateOf(stmts);
    expect(cand.sql).toMatch(/r\.task_id = ANY\(\$1::text\[\]\)/);
    expect(cand.sql).not.toMatch(/code_version =/);
    expect(cand.sql).not.toMatch(/serving/);
    // Task ids + window + the namespace pair, and nothing else: an extra
    // parameter here would mean the default path had started pinning.
    expect(cand.params).toHaveLength(4);
  });
});

describe('claimRuns with pinning', () => {
  it('filters on (task, version) pairs in SQL, carrying the versions as $3', async () => {
    const { pool, stmts } = stubPool();

    await claimRuns(pool, { ...ARGS, codeVersions: ['v_a', 'v_b'] });

    const cand = candidateOf(stmts);
    expect(cand.sql).toMatch(/unnest\(\$1::text\[\], \$3::text\[\]\)/);
    expect(cand.sql).toMatch(/JOIN serving s ON s\.task_id = r\.task_id/);
    expect(cand.sql).toMatch(/r\.code_version = s\.code_version/);
    expect(cand.params[0]).toEqual(['send-email', 'sync-crm']);
    expect(cand.params[2]).toEqual(['v_a', 'v_b']);
  });

  it('leaves version-less runs claimable', async () => {
    const { pool, stmts } = stubPool();

    await claimRuns(pool, { ...ARGS, codeVersions: ['v_a', 'v_b'] });

    // A run created before its task was ever registered carries no version, so
    // there is nothing to honour and no ledger written against one. Pinning
    // must not quietly make those unclaimable by anybody.
    expect(candidateOf(stmts).sql).toMatch(/r\.code_version IS NULL OR/);
  });

  it('still locks the queue row and only the queue row', async () => {
    const { pool, stmts } = stubPool();

    await claimRuns(pool, { ...ARGS, codeVersions: ['v_a', 'v_b'] });

    const cand = candidateOf(stmts);
    expect(cand.sql).toMatch(/FOR UPDATE OF q SKIP LOCKED/);
    // A bare `FOR UPDATE` would lock runs (and the CTE) too, breaking the
    // canonical queue → runs order.
    expect(cand.sql).not.toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('claims the same window and returns the same ClaimedRun shape', async () => {
    const { pool } = stubPool([
      {
        queue_id: 5,
        run_id: 'run_1',
        task_id: 'send-email',
        payload: {},
        attempt: 1,
        max_attempts: 3,
        code_version: 'v_a',
        project_id: 'default',
        env: 'prod',
        concurrency_key: null,
        concurrency_limit: null,
      },
    ]);

    const claimed = await claimRuns(pool, { ...ARGS, codeVersions: ['v_a', 'v_b'] });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe('run_1');
    expect(claimed[0]!.codeVersion).toBe('v_a');
    expect(claimed[0]!.fencingToken).toBe(1);
  });

  it('refuses arrays that are not parallel instead of pinning by accident', async () => {
    const { pool, stmts } = stubPool();

    await expect(
      claimRuns(pool, { ...ARGS, codeVersions: ['v_a'] }),
    ).rejects.toBeInstanceOf(KernelError);
    // Rejected before a connection was even used — an off-by-one here would
    // otherwise pin one task to another's version and quietly stop claiming.
    expect(stmts).toHaveLength(0);
  });

  it('is a no-op for an empty task set, pinned or not', async () => {
    const { pool, stmts } = stubPool();

    expect(await claimRuns(pool, { ...ARGS, taskIds: [], codeVersions: [] })).toEqual([]);
    expect(stmts).toHaveLength(0);
  });
});
