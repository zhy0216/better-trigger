/* =============================================================================
   @better-trigger/kernel — claimRuns expected-state guard (todos/p2-39).

   The candidate scan filters on `runs.status = 'queued'`, so a live Postgres
   can never hand the claim loop a non-queued run — the queue-row lock the
   scan holds serializes every path that could move the run. The 0-row flip
   branch is therefore DEFENSE against a future path or a hand-repaired row,
   and a live server can never exercise it (outside the fault-injection race
   test in pg/stale-state-guards.test.ts). It is pinned here with a stub: a
   candidate that the runs UPDATE answers with 0 rows must stop the claim —
   no lease on the queue row, no ledger read, nothing returned, the skip is
   said out loud through the injected logger, and the stale queue row is
   DELETED when the run has moved to a terminal/'waiting' state (p2-39 §2)
   while a 'running'/'queued' run keeps its row (a live-claim race).
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { claimRuns } from '../src/queue';
import type { KernelLogger } from '../src/kernel';

interface Stmt {
  sql: string;
  params: unknown[];
}

function stubPool(flipRows: 0 | 1, runStatus = 'completed') {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM queue q/.test(sql)) {
        return {
          rows: [
            {
              queue_id: 1,
              run_id: 'run_1',
              task_id: 't1',
              payload: {},
              attempt: 1,
              max_attempts: 3,
              code_version: null,
              project_id: 'default',
              env: 'prod',
              concurrency_key: null,
              concurrency_limit: null,
            },
          ],
        };
      }
      if (/RETURNING fencing_token/.test(sql)) {
        return flipRows === 1
          ? { rows: [{ fencing_token: '5' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/SELECT status FROM runs/.test(sql)) {
        return runStatus === 'missing' ? { rows: [] } : { rows: [{ status: runStatus }] };
      }
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: '0' }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, stmts };
}

const ARGS = {
  workerId: 'w1',
  namespaces: [{ projectId: 'default', env: 'prod' }],
  taskIds: ['t1'],
  leaseMs: 60_000,
  limit: 1,
};

describe('claimRuns expected-state guard (p2-39)', () => {
  it('a 0-row status flip on a running/queued run stops the claim: no lease, no ledger read, nothing claimed, queue row kept, and the skip is logged', async () => {
    for (const status of ['running', 'queued']) {
      const lines: string[] = [];
      const logger: KernelLogger = {
        warn: (...args: unknown[]) => lines.push(String(args[0])),
        error: () => {},
      };
      const { pool, stmts } = stubPool(0, status);

      const claimed = await claimRuns(pool, { ...ARGS, logger });

      expect(claimed).toEqual([]);
      // The runs flip came back empty → the queue lease must never be written
      // (the queue UPDATE comes AFTER the flip) and the ledger is never read.
      expect(stmts.some((s) => /UPDATE queue/.test(s.sql))).toBe(false);
      expect(stmts.some((s) => /FROM run_steps/.test(s.sql))).toBe(false);
      // A 'running'/'queued' run is a live-claim race, not residue: its queue
      // row is kept — the delete branch must never fire.
      expect(stmts.some((s) => /^DELETE FROM queue/.test(s.sql))).toBe(false);
      // And the desync is diagnosed, not swallowed.
      expect(lines.some((m) => m.includes('[queue:claim]') && m.includes('stale'))).toBe(true);
      expect(lines.some((m) => m.includes(`runs.status '${status}'`))).toBe(true);
    }
  });

  it('a 0-row status flip on a terminal/waiting/missing run deletes the stale queue row (source: claim), still claiming nothing', async () => {
    for (const status of ['completed', 'failed', 'canceled', 'waiting', 'missing']) {
      const lines: string[] = [];
      const logger: KernelLogger = {
        warn: (...args: unknown[]) => lines.push(String(args[0])),
        error: () => {},
      };
      const { pool, stmts } = stubPool(0, status);

      const claimed = await claimRuns(pool, { ...ARGS, logger });

      expect(claimed).toEqual([]);
      // The queue row is residue a terminal/'waiting' run must not carry —
      // deleted under the lock the claim already holds, scoped by the
      // (run_id, project_id, env) triple, and said out loud with the old
      // status and the source loop.
      const del = stmts.find((s) => /^DELETE FROM queue/.test(s.sql));
      expect(del).toBeTruthy();
      expect(del!.params).toEqual(['run_1', 'default', 'prod']);
      expect(
        lines.some(
          (m) =>
            m.includes('[queue:claim]') &&
            m.includes(`runs.status '${status}'`) &&
            m.includes('stale queue row deleted') &&
            m.includes('source: claim'),
        ),
      ).toBe(true);
      // Still no lease write and no ledger read.
      expect(stmts.some((s) => /UPDATE queue/.test(s.sql))).toBe(false);
      expect(stmts.some((s) => /FROM run_steps/.test(s.sql))).toBe(false);
    }
  });

  it('a 1-row flip claims as before: lease taken, token from the RETURNING', async () => {
    const { pool, stmts } = stubPool(1);

    const claimed = await claimRuns(pool, ARGS);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.fencingToken).toBe(5);
    expect(stmts.some((s) => /UPDATE queue/.test(s.sql))).toBe(true);
    expect(stmts.some((s) => /FROM run_steps/.test(s.sql))).toBe(true);
  });

  it('the candidate scan carries the status predicate and the flip UPDATE too', async () => {
    const { pool, stmts } = stubPool(1);
    await claimRuns(pool, ARGS);

    const scan = stmts.find((s) => /FROM queue q/.test(s.sql))!;
    expect(scan.sql).toMatch(/r\.status = 'queued'/);
    const flip = stmts.find((s) => /RETURNING fencing_token/.test(s.sql))!;
    expect(flip.sql).toMatch(/AND status = 'queued'/);
  });
});
