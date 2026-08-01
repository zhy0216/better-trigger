/* =============================================================================
   @better-trigger/kernel — stranded-run scan.

   Version pinning trades "a run may be replayed by code that does not match its
   ledger" for "a run may wait forever". The second half only works if waiting
   forever is visible, which is what this scan is: due, unclaimed runs whose
   code version no online worker serves.

   What is pinned here:

     - "served" is read off the online workers' task manifests, including the
       legacy bare-id shape (worker rows outlive the build that wrote them, so
       both shapes are live data rather than a migration window);
     - only DUE and UNCLAIMED runs count — a delayed run is not stuck yet, and a
       claimed one is being executed right now;
     - version-less runs are never stranded (nothing pins them);
     - the group cap truncates rather than growing metric cardinality without
       bound, and says so.

   No Postgres: a stub pool returns canned rows and records the SQL.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { scanStrandedRuns } from '../src/queue';

function stubPool(rows: Array<{ task_id: string; code_version: string; n: string }>) {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const pool = {
    query: async (sql: string, p: unknown[] = []) => {
      sqls.push(sql);
      params.push(p);
      return { rows };
    },
  } as unknown as Pool;
  return { pool, sqls, params };
}

const group = (taskId: string, n: number) => ({
  task_id: taskId,
  code_version: 'v_gone',
  n: String(n),
});

describe('scanStrandedRuns', () => {
  it('groups by task and version', async () => {
    const { pool } = stubPool([group('send-invoice', 3), group('sync-crm', 1)]);

    const scan = await scanStrandedRuns(pool);

    expect(scan.groups).toEqual([
      { taskId: 'send-invoice', codeVersion: 'v_gone', count: 3 },
      { taskId: 'sync-crm', codeVersion: 'v_gone', count: 1 },
    ]);
    expect(scan.truncated).toBe(false);
  });

  it('asks only about runs that are due, unclaimed and versioned', async () => {
    const { pool, sqls } = stubPool([]);

    await scanStrandedRuns(pool);

    const sql = sqls[0]!;
    expect(sql).toMatch(/q\.locked_by IS NULL/);
    expect(sql).toMatch(/q\.available_at <= now\(\)/);
    expect(sql).toMatch(/r\.code_version IS NOT NULL/);
  });

  it('reads the served set off online workers, both manifest shapes', async () => {
    const { pool, sqls } = stubPool([]);

    await scanStrandedRuns(pool);

    const sql = sqls[0]!;
    expect(sql).toMatch(/w\.status = 'online'/);
    // { id, codeVersion } objects, and the bare-id strings an older build wrote
    // (those fall back to the worker's own version, which is what it stamped).
    expect(sql).toMatch(/COALESCE\(e->>'id', e #>> '\{\}'\)/);
    expect(sql).toMatch(/COALESCE\(e->>'codeVersion', w\.code_version\)/);
  });

  it('caps the groups it reports and says when it truncated', async () => {
    // One row past the cap is what the query asks for, so "exactly full" and
    // "there was more" are distinguishable without a second count.
    const { pool, params } = stubPool(
      Array.from({ length: 21 }, (_, i) => group(`task-${i}`, 21 - i)),
    );

    const scan = await scanStrandedRuns(pool);

    expect(params[0]![0]).toBe(21);
    expect(scan.groups).toHaveLength(20);
    expect(scan.truncated).toBe(true);
  });

  it('reports nothing when nothing is stranded', async () => {
    const { pool } = stubPool([]);

    const scan = await scanStrandedRuns(pool);

    expect(scan.groups).toEqual([]);
    expect(scan.truncated).toBe(false);
  });
});
