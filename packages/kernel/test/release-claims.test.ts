/* =============================================================================
   @better-trigger/kernel — releaseClaims / deregisterWorker (C3).

   The graceful-shutdown counterpart of the lease reaper, pinned at the SQL
   level against a stub client: what these two statements do (and, above all,
   what they must NOT do) is the whole feature.

     - a released claim must never charge a counter. The reaper's recovery path
       is `recoveries + 1` (C4); if a clean SIGTERM went through it, every
       deploy would spend one of the run's infrastructure recoveries, and a
       long-lived run would eventually be declared 'worker lost' by nothing
       worse than a `docker compose restart`. (`attempt` — the user's own retry
       budget — must stay untouched here for the same reason, and is not the
       reaper's to spend either.)
     - it must never touch runs.fencing_token: only claimRuns bumps it, and
       clearing locked_by already makes a late write from the old executor fail
       assertOwnedRunning immediately (fencing gets *tighter* here, not looser).
     - it must only ever release rows this worker owns.
     - the runs row goes back to 'queued' — a released run left 'running' would
       be counted against its own concurrency_key by the next claim's limit
       check, so a concurrency_limit-1 task could never be picked up again.

   No Postgres: the stub answers the four statements in order and records them,
   which is exactly the granularity these invariants live at.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { releaseClaims } from '../src/queue';
import { deregisterWorker } from '../src/workers';

interface Stmt {
  sql: string;
  params: unknown[];
}

/** A pool whose single client answers the queue lock with `heldRunIds`. */
function stubPool(heldRunIds: string[], opts: { failOn?: RegExp } = {}) {
  const stmts: Stmt[] = [];
  let released = false;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (opts.failOn?.test(sql)) throw new Error('boom');
      if (/FROM queue/.test(sql)) {
        return {
          rows: heldRunIds.map((run_id) => ({
            run_id,
            project_id: 'default',
            env: 'prod',
          })),
        };
      }
      if (/UPDATE queue/.test(sql)) {
        return { rows: heldRunIds.map((run_id) => ({ run_id })) };
      }
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, stmts, wasReleased: () => released };
}

const sqlOf = (stmts: Stmt[]) => stmts.map((s) => s.sql).join('\n');
const indexOf = (stmts: Stmt[], re: RegExp) => stmts.findIndex((s) => re.test(s.sql));

describe('releaseClaims', () => {
  it('hands the claims back without spending an attempt or a recovery', async () => {
    const { pool, stmts } = stubPool(['run_1', 'run_2']);

    const res = await releaseClaims(pool, { workerId: 'w1', namespaces: [DEFAULT_NAMESPACE] });

    expect(res.releasedRunIds).toEqual(['run_1', 'run_2']);
    // The core of C3: no attempt arithmetic anywhere on this path, and no
    // fencing-token bump either. Since C4 the same holds for `recoveries` —
    // a graceful stop is neither a failure nor an infrastructure recovery.
    expect(sqlOf(stmts)).not.toMatch(/attempt/i);
    expect(sqlOf(stmts)).not.toMatch(/recover/i);
    expect(sqlOf(stmts)).not.toMatch(/fencing_token/i);
  });

  it('clears owner + lease and makes the run available immediately', async () => {
    const { pool, stmts } = stubPool(['run_1']);

    await releaseClaims(pool, { workerId: 'w1', namespaces: [DEFAULT_NAMESPACE] });

    const update = stmts.find((s) => /UPDATE queue/.test(s.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/locked_by = NULL/);
    expect(update!.sql).toMatch(/locked_at = NULL/);
    expect(update!.sql).toMatch(/lease_until = NULL/);
    expect(update!.sql).toMatch(/available_at = now\(\)/);
  });

  it('only ever touches rows this worker owns', async () => {
    const { pool, stmts } = stubPool(['run_1']);

    await releaseClaims(pool, { workerId: 'w1', namespaces: [DEFAULT_NAMESPACE] });

    // Both the lock and the release are scoped by locked_by, bound to us.
    const lock = stmts.find((s) => /FROM queue/.test(s.sql))!;
    expect(lock.sql).toMatch(/WHERE locked_by = \$1/);
    expect(lock.sql).toMatch(/FOR UPDATE/);
    expect(lock.params[0]).toBe('w1');

    const update = stmts.find((s) => /UPDATE queue/.test(s.sql))!;
    expect(update.sql).toMatch(/WHERE locked_by = \$1 AND \(run_id, project_id, env\) IN \(VALUES/);
    expect(update.params).toEqual(['w1', 'run_1', 'default', 'prod']);
  });

  it('with runIds filters the lock to the named runs, scoped to this worker (p1-12)', async () => {
    // p1-12: the runtime hands back a single freshly-claimed run when stop()
    // lands between the claim and the executor; the filter must restrict the
    // release to ONLY that run (the SQL does the filtering — this stub answers
    // every FROM queue with all rows, so the SELECT-level filter is what we
    // pin here).
    const { pool, stmts } = stubPool(['run_1', 'run_2']);

    await releaseClaims(pool, {
      workerId: 'w1',
      namespaces: [DEFAULT_NAMESPACE],
      runIds: ['run_1'],
    });

    // The lock SELECT restricts to the named runs on top of this worker's
    // namespace scoping: $1 = worker, $2/$3 = the namespace pair, $4 = the
    // run-id array (the namespace predicate sits between them).
    const lock = stmts.find((s) => /FROM queue/.test(s.sql))!;
    expect(lock.sql).toMatch(/WHERE locked_by = \$1 AND .*AND run_id = ANY\(\$4::text\[\]\)/);
    expect(lock.sql).toMatch(/FOR UPDATE/);
    expect(lock.params).toEqual(['w1', 'default', 'prod', ['run_1']]);
    // Without the filter this is the whole-claims release — assert the array
    // is really there (a regression that drops the filter would omit $4).
    expect(lock.params).not.toEqual(['w1', 'default', 'prod']);
  });

  it('puts the run back to queued so the next claim can count it correctly', async () => {
    const { pool, stmts } = stubPool(['run_1']);

    await releaseClaims(pool, { workerId: 'w1', namespaces: [DEFAULT_NAMESPACE] });

    const runsUpdate = stmts.find((s) => /UPDATE runs/.test(s.sql))!;
    expect(runsUpdate.sql).toMatch(/SET status = 'queued'/);
    expect(runsUpdate.sql).toMatch(/WHERE id = \$1 AND status = 'running' AND project_id = \$2 AND env = \$3/);
    expect(runsUpdate.params).toEqual(['run_1', 'default', 'prod']);
  });

  it('acquires locks in the canonical order (queue row, then runs row)', async () => {
    const { pool, stmts } = stubPool(['run_1']);

    await releaseClaims(pool, { workerId: 'w1', namespaces: [DEFAULT_NAMESPACE] });

    // Position 1 before position 2 — the invariant runs.ts's header pins.
    expect(indexOf(stmts, /FROM queue/)).toBeLessThan(
      indexOf(stmts, /UPDATE runs/),
    );
    expect(stmts[0]!.sql).toBe('BEGIN');
    expect(stmts.at(-1)!.sql).toBe('COMMIT');
  });

  it('is a no-op when this worker holds nothing (repeat calls, crash drains)', async () => {
    const { pool, stmts } = stubPool([]);

    const res = await releaseClaims(pool, { workerId: 'w1', namespaces: [DEFAULT_NAMESPACE] });

    expect(res.releasedRunIds).toEqual([]);
    expect(sqlOf(stmts)).not.toMatch(/UPDATE (queue|runs)/);
    expect(stmts.map((s) => s.sql)).toEqual([
      'BEGIN',
      expect.stringMatching(/FROM queue/) as unknown as string,
      'COMMIT',
    ]);
  });

  it('rolls back and rethrows rather than half-releasing', async () => {
    const { pool, stmts, wasReleased } = stubPool(['run_1'], { failOn: /UPDATE runs/ });

    await expect(releaseClaims(pool, { workerId: 'w1', namespaces: [DEFAULT_NAMESPACE] })).rejects.toThrow('boom');

    expect(sqlOf(stmts)).toMatch(/ROLLBACK/);
    expect(sqlOf(stmts)).not.toMatch(/COMMIT/);
    expect(wasReleased()).toBe(true); // connection handed back to the pool
  });
});

describe('deregisterWorker', () => {
  it('marks exactly this worker offline, in one statement', async () => {
    const { pool, stmts } = stubPool([]);

    await deregisterWorker(pool, { workerId: 'w1' });

    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toMatch(/UPDATE workers SET status = 'offline' WHERE id = \$1/);
    expect(stmts[0]!.params).toEqual(['w1']);
  });
});
