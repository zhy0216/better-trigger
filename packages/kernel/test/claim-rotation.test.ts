/* =============================================================================
   @better-trigger/kernel — namespace scan rotation in claimRuns (P0-14).

   The per-namespace candidate scans share one `limit` and stop once it is
   met. Pinned to array order, a worker whose `namespaces[0]` always has
   claimable runs never scans anything further back — those namespaces
   starve indefinitely. claimRuns gained `rotateFrom`: the caller (the
   runtime) advances the scan start once per claim, and `onScanSkipped`
   reports the unscanned tail so the skip is observable.

   What is pinned here (no Postgres, stub client per claim-batching.test.ts):

     - rotateFrom picks the scan start; any integer normalizes into the list
       (3 ≡ 1 and −1 ≡ 1 on two namespaces), undefined keeps the historical
       array order;
     - onScanSkipped fires with exactly the namespaces the rotation order did
       not reach before the budget filled — and never when nothing was
       skipped;
     - the starvation property: with namespaces[0] always busy (≥ 2×limit
       pending) and the runtime-style rotation, namespaces[1] claims within a
       bounded number of rounds; without rotation it claims nothing in the
       same number of rounds (the P0-14 bug, kept as a pinned contrast).
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Namespace } from '@better-trigger/core';
import { claimRuns } from '../src/queue';

const NS_A: Namespace = { projectId: 'acme', env: 'staging' };
const NS_B: Namespace = { projectId: 'acme', env: 'prod' };

interface Stmt {
  sql: string;
  params: unknown[];
}

/**
 * A pool whose every namespace is ALWAYS busy: each candidate scan answers
 * with one claimable row for the (project_id, env) pair that scan asked
 * about (params [taskIds, window, projectId, env], non-pinned shape). Models
 * an endless backlog, which is exactly the starvation setup.
 */
function busyPool() {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM queue q/.test(sql)) {
        const projectId = params[2] as string;
        const env = params[3] as string;
        return {
          rows: [
            {
              queue_id: 1,
              run_id: `run_${env}`,
              task_id: 't',
              payload: null,
              attempt: 1,
              max_attempts: 1,
              code_version: null,
              project_id: projectId,
              env,
              concurrency_key: null,
              concurrency_limit: null,
            },
          ],
        };
      }
      if (/FROM run_steps/.test(sql)) return { rows: [] };
      if (/RETURNING fencing_token/.test(sql))
        return { rows: [{ fencing_token: '7' }], rowCount: 1 };
      if (/UPDATE queue/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, stmts };
}

const ARGS = {
  workerId: 'w1',
  namespaces: [NS_A, NS_B],
  taskIds: ['t'],
  limit: 1,
  leaseMs: 60_000,
};

const candidateScans = (stmts: Stmt[]) => stmts.filter((s) => /FROM queue q/.test(s.sql));
const scanPair = (s: Stmt) => `${s.params[2]}/${s.params[3]}`;

describe('claimRuns namespace rotation (P0-14)', () => {
  it('rotateFrom picks the namespace the scan order starts at', async () => {
    const { pool, stmts } = busyPool();
    await claimRuns(pool, { ...ARGS, rotateFrom: 1 });
    expect(scanPair(candidateScans(stmts)[0]!)).toBe('acme/prod');

    const fresh = busyPool();
    await claimRuns(fresh.pool, { ...ARGS, rotateFrom: 0 });
    expect(scanPair(candidateScans(fresh.stmts)[0]!)).toBe('acme/staging');

    // Undefined keeps the historical array order.
    const legacy = busyPool();
    await claimRuns(legacy.pool, ARGS);
    expect(scanPair(candidateScans(legacy.stmts)[0]!)).toBe('acme/staging');
  });

  it('normalizes any integer into the namespace list', async () => {
    for (const rotate of [3, -1, 5]) {
      // 3 ≡ 5 ≡ 1 (mod 2); −1 counts from the end ≡ 1. All must start at ns B.
      const { pool, stmts } = busyPool();
      await claimRuns(pool, { ...ARGS, rotateFrom: rotate });
      expect(scanPair(candidateScans(stmts)[0]!)).toBe('acme/prod');
    }
    for (const rotate of [2, -2, 4]) {
      const { pool, stmts } = busyPool();
      await claimRuns(pool, { ...ARGS, rotateFrom: rotate });
      expect(scanPair(candidateScans(stmts)[0]!)).toBe('acme/staging');
    }
  });

  it('onScanSkipped reports exactly the unscanned tail', async () => {
    const skipped: Namespace[][] = [];
    const { pool } = busyPool();
    await claimRuns(pool, { ...ARGS, rotateFrom: 0, onScanSkipped: (s) => skipped.push([...s]) });
    // ns A claimed the whole budget; ns B never got a scan.
    expect(skipped).toEqual([[NS_B]]);

    skipped.length = 0;
    await claimRuns(pool, { ...ARGS, rotateFrom: 1, onScanSkipped: (s) => skipped.push([...s]) });
    expect(skipped).toEqual([[NS_A]]);

    // Nothing skipped when the budget outlives the list: both namespaces
    // scan, the callback never fires.
    skipped.length = 0;
    await claimRuns(pool, { ...ARGS, limit: 5, rotateFrom: 0, onScanSkipped: (s) => skipped.push([...s]) });
    expect(skipped).toEqual([]);
  });

  it('without rotation a busy namespaces[0] starves namespaces[1] (the P0-14 bug)', async () => {
    // Six claims, ns A always has ≥ 2×limit of backlog: every round spends
    // the budget on A before B is even scanned.
    const claimedEnvs: string[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      const { pool } = busyPool();
      const claimed = await claimRuns(pool, ARGS);
      for (const c of claimed) claimedEnvs.push(c.env);
    }
    expect(claimedEnvs).toEqual(['staging', 'staging', 'staging', 'staging', 'staging', 'staging']);
  });

  it('with runtime-style rotation namespaces[1] claims within a bounded number of rounds', async () => {
    // The rotation the runtime drives: advance the start by one per claim.
    const claimedEnvs: string[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      const { pool } = busyPool();
      const claimed = await claimRuns(pool, { ...ARGS, rotateFrom: turn % 2 });
      for (const c of claimed) claimedEnvs.push(c.env);
    }
    // B leads every other round, so it claims even while A stays busy — and
    // no namespace is starved for more than namespaces.length − 1 rounds.
    expect(claimedEnvs).toEqual(['staging', 'prod', 'staging', 'prod', 'staging', 'prod']);
    let maxRun = 0;
    let current = 0;
    for (const env of claimedEnvs) {
      current = env === 'staging' ? current + 1 : 0;
      maxRun = Math.max(maxRun, current);
    }
    expect(maxRun).toBeLessThanOrEqual(ARGS.namespaces.length);
  });

  it('a single namespace rotates to itself — the order never changes', async () => {
    for (const rotateFrom of [0, 1, 7]) {
      const { pool, stmts } = busyPool();
      const claimed = await claimRuns(pool, {
        ...ARGS,
        namespaces: [NS_A],
        rotateFrom,
      });
      expect(scanPair(candidateScans(stmts)[0]!)).toBe('acme/staging');
      expect(claimed.map((c) => c.env)).toEqual(['staging']);
    }
  });
});
