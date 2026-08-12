/* =============================================================================
   @better-trigger/kernel — concurrency limiter advisory-lock namespace (PF7).

   The limiter used to take `pg_advisory_xact_lock(hashtext('bt:cc:…'))`. That
   one-argument form shares its bigint key space with every other user of the
   database, and running the daemon against the application's own database is a
   documented deployment — an unrelated `pg_advisory_lock` in application code
   could then silently serialize claims (or be serialized by them).

   What is pinned here:

     - the lock is the two-argument (classid, objid) form, under better-trigger's
       own classid — a space nothing else in the database writes to, and one
       `pg_locks` attributes at a glance;
     - the classid is CONCURRENCY_LOCK_CLASS ('btcc') and it is NOT the migration
       lock's class ('btmg', packages/db/src/migrate.ts) — different classid means
       the two objid spaces cannot meet;
     - the objid is still hashtext of the same `bt:cc:<key>` string, taken inside
       the claim transaction before the count: namespacing the key must not change
       *which* claims serialize against each other, only who else can join in.

   No Postgres: a stub client replays canned candidate rows and records the
   statements, same shape as claim-batching.test.ts.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { CONCURRENCY_LOCK_CLASS, claimRuns } from '../src/queue';

interface Stmt {
  sql: string;
  params: unknown[];
}

/** One capped candidate: task limit 1 with a run already running → it is skipped. */
const cappedCandidate = {
  queue_id: 1,
  run_id: 'run_1',
  task_id: 'send-email',
  payload: {},
  attempt: 0,
  max_attempts: 3,
  code_version: null,
  project_id: 'default',
  env: 'prod',
  concurrency_key: 'tenant-1',
  concurrency_limit: 1,
};

function stubPool(rows: unknown[], running: number) {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM queue q/.test(sql)) return { rows };
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: String(running) }] };
      if (/RETURNING fencing_token/.test(sql)) return { rows: [{ fencing_token: '1' }] };
      return { rows: [] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, stmts };
}

const ARGS = {
  workerId: 'w1',
  namespaces: [DEFAULT_NAMESPACE],
  taskIds: ['send-email'],
  limit: 1,
  leaseMs: 60_000,
};
const lockOf = (stmts: Stmt[]) => stmts.find((s) => /pg_advisory_xact_lock/.test(s.sql))!;

describe('concurrency limiter advisory lock', () => {
  it('takes the two-argument form under better-trigger’s own classid', async () => {
    const { pool, stmts } = stubPool([cappedCandidate], 1);

    await claimRuns(pool, ARGS);

    const lock = lockOf(stmts);
    expect(lock.sql).toMatch(/pg_advisory_xact_lock\(\$1::int4, hashtext\(\$2\)\)/);
    // The single-argument form is what PF7 replaced: it would put this key in
    // the space application code shares.
    expect(lock.sql).not.toMatch(/pg_advisory_xact_lock\(hashtext/);
    expect(lock.params[0]).toBe(CONCURRENCY_LOCK_CLASS);
    expect(lock.params[1]).toBe('bt:cc:default:prod:tenant-1');
  });

  it('uses a classid distinct from the migration lock’s', () => {
    // packages/db/src/migrate.ts LOCK_CLASS, duplicated on purpose: @db is not a
    // dependency of @kernel, and the point of the assertion is that the two
    // constants must stay different.
    const MIGRATE_LOCK_CLASS = 0x62_74_6d_67; // 'btmg'
    expect(CONCURRENCY_LOCK_CLASS).not.toBe(MIGRATE_LOCK_CLASS);
    // Both are int4 — pg_advisory_xact_lock(int, int) is the overload we want.
    expect(CONCURRENCY_LOCK_CLASS).toBeLessThanOrEqual(0x7f_ff_ff_ff);
    expect(CONCURRENCY_LOCK_CLASS).toBe(0x62_74_63_63); // 'btcc'
  });

  it('still holds the lock before the count, in the claim transaction', async () => {
    const { pool, stmts } = stubPool([cappedCandidate], 0);

    await claimRuns(pool, ARGS);

    const shapes = stmts.map((s) => s.sql.trim().split(/\s+/)[0]);
    const lockAt = stmts.findIndex((s) => /pg_advisory_xact_lock/.test(s.sql));
    const countAt = stmts.findIndex((s) => /count\(\*\)/.test(s.sql));
    expect(shapes[0]).toBe('BEGIN');
    expect(lockAt).toBeGreaterThan(0);
    expect(countAt).toBeGreaterThan(lockAt);
    // Transaction scoped: released by COMMIT, never unlocked by hand. COMMIT
    // still ends the claim transaction (releasing the xact lock) — the run_steps
    // snapshot read now follows it outside the transaction (p1-07).
    expect(stmts.some((s) => /pg_advisory_unlock/.test(s.sql))).toBe(false);
    const commitAt = stmts.findIndex((s) => s.sql === 'COMMIT');
    expect(commitAt).toBeGreaterThan(countAt);
    expect(stmts.findIndex((s) => /FROM run_steps/.test(s.sql))).toBeGreaterThan(commitAt);
  });
});
