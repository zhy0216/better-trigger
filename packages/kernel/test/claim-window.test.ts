/* =============================================================================
   @better-trigger/kernel — claimRuns candidate window (PF3).

   The window used to be a hardcoded `LIMIT 10` while the signature took a
   `limit`, so every `limit: 1` slot poll locked ten queue rows FOR UPDATE, took
   one, and released the other nine at COMMIT. Rows held that way are invisible
   to the other slots (SKIP LOCKED), which both wastes round trips and bends the
   priority order: the head of the queue can be locked inside someone else's
   window while a lower-priority row gets executed instead.

   What is pinned here:

     - the window follows `limit` (limit 1 → 10, limit 20 → 40), so a batching
       caller gets enough candidates and a single-slot caller stops hoarding;
     - the floor of 10 survives, because candidates can be *skipped* after being
       locked (a task at its concurrency limit) — a window of exactly `limit`
       would report "nothing to claim" with claimable runs one row further down;
     - the window goes through a bound parameter, never string concatenation:
       no way to smuggle SQL in through a numeric knob, and one prepared plan
       PG can reuse instead of a new statement text per limit.

   No Postgres: a stub client answers the candidate SELECT with no rows and
   records the statements, which is where this invariant lives.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { claimRuns, claimWindow } from '../src/queue';

interface Stmt {
  sql: string;
  params: unknown[];
}

/** A pool whose candidate SELECT finds nothing — we only read the statement. */
function stubPool() {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, stmts };
}

const ARGS = {
  workerId: 'w1',
  namespaces: [DEFAULT_NAMESPACE],
  taskIds: ['t1'],
  leaseMs: 60_000,
};
const candidateOf = (stmts: Stmt[]) => stmts.find((s) => /FROM queue q/.test(s.sql))!;

describe('claimRuns candidate window', () => {
  it('keeps a floor of 10 for the single-slot poll', async () => {
    const { pool, stmts } = stubPool();

    await claimRuns(pool, { ...ARGS, limit: 1 });

    const cand = candidateOf(stmts);
    expect(cand.params[1]).toBe(10);
  });

  it('widens with the limit so a batch claim has candidates to work with', async () => {
    const { pool, stmts } = stubPool();

    await claimRuns(pool, { ...ARGS, limit: 20 });

    const cand = candidateOf(stmts);
    expect(cand.params[1]).toBe(40);
  });

  it('binds the window instead of splicing it into the SQL', async () => {
    const { pool, stmts } = stubPool();

    await claimRuns(pool, { ...ARGS, limit: 20 });

    const cand = candidateOf(stmts);
    // Parameterized: nothing numeric is concatenated into the statement, and
    // the text is identical whatever the limit is (one reusable plan).
    expect(cand.sql).toMatch(/LIMIT \$2/);
    expect(cand.sql).not.toMatch(/LIMIT\s+\d/);
    expect(cand.params[0]).toEqual(['t1']);

    const { pool: other, stmts: otherStmts } = stubPool();
    await claimRuns(other, { ...ARGS, limit: 1 });
    expect(candidateOf(otherStmts).sql).toBe(cand.sql);
  });

  it('leaves room for candidates skipped by the concurrency limit', () => {
    // 2x, never 1x: every claimed candidate may be skipped instead (task at its
    // concurrency cap), so a window of exactly `limit` can come back empty while
    // the queue holds claimable runs.
    expect(claimWindow(1)).toBeGreaterThan(1);
    expect(claimWindow(20)).toBeGreaterThan(20);
    expect(claimWindow(5)).toBe(10);
    expect(claimWindow(6)).toBe(12);
  });

  it('never opens a transaction when there is nothing to claim', async () => {
    const { pool, stmts } = stubPool();

    expect(await claimRuns(pool, { ...ARGS, limit: 0 })).toEqual([]);
    expect(await claimRuns(pool, { ...ARGS, taskIds: [], limit: 1 })).toEqual([]);
    expect(stmts).toEqual([]);
  });
});
