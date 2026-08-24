/* =============================================================================
   @better-trigger/kernel — retryRun's operation-key SQL shape (p2-38).

   The pg suite (test/pg/retry-idempotency.test.ts) asserts the behavior; this
   stub pins the STATEMENTS: with an operation key the transaction locks the
   source in canonical order (queue row, runs row), probes run_retry_operations
   FOR UPDATE, records the operation AFTER its run insert, and a unique
   violation on the operation table's OWN PK — the defense-in-depth branch, in
   practice only reachable by an FK-bypassing writer — rolls back and re-reads
   the winner outside the aborted transaction. A 23505 on any OTHER constraint
   is rethrown untouched, and a read-back that finds no winner becomes a
   stable conflict instead of the raw pg error. Without a key none of the
   operation SQL exists at all.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { retryRun } from '../src/runs';

interface Stmt {
  sql: string;
  params: unknown[];
}

interface PoolConfig {
  /** What the in-tx operation probe returns (default: no row → fresh retry). */
  opRow?: { retry_run_id: string };
  /** Error to throw from the operation INSERT (e.g. the 23505 defense path). */
  opInsertError?: unknown;
  /** What the post-rollback read-back returns (default: none → conflict). */
  winner?: { retry_run_id: string };
}

/** The constraint name pg reports for run_retry_operations' PK. Migration 0015
 *  declares "..._operation_key_pk", but pg truncates identifiers to 63 bytes,
 *  so the live name drops the "_pk" suffix (this is what err.constraint
 *  actually carries in production). */
const OP_PK_CONSTRAINT = 'run_retry_operations_project_id_env_source_run_id_operation_key';

const SOURCE = {
  id: 'run_src',
  task_id: 't',
  status: 'failed',
  attempt: 3,
  max_attempts: 3,
  recoveries: 0,
  max_recoveries: 10,
  parent_run_id: null,
  payload: { a: 1 },
  project_id: 'default',
  env: 'staging',
  concurrency_key: null,
  priority: 0,
  code_version: null,
  fencing_token: '4',
};

const makePool = (cfg: PoolConfig = {}) => {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM run_retry_operations/.test(sql)) {
        return { rows: cfg.opRow ? [cfg.opRow] : [] };
      }
      if (/FROM runs WHERE id/.test(sql)) return { rows: [{ ...SOURCE }] };
      if (/FROM tasks/.test(sql)) {
        return { rows: [{ id: 't', retry: null, concurrency_limit: null, latest_code_version: null }] };
      }
      if (/INSERT INTO runs/.test(sql)) return { rows: [{ id: 'run_new' }] };
      if (/INSERT INTO run_retry_operations/.test(sql)) {
        if (cfg.opInsertError) throw cfg.opInsertError;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
    // The unique-violation loser re-reads the winner through a FRESH connection
    // (outside the aborted tx); the stub pool answers it directly.
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM run_retry_operations/.test(sql)) {
        return { rows: cfg.winner ? [cfg.winner] : [] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, stmts };
};

const find = (stmts: Stmt[], re: RegExp): Stmt => {
  const stmt = stmts.find((s) => re.test(s.sql));
  expect(stmt, `no statement matching ${re}`).toBeDefined();
  return stmt!;
};

const opInsert = (stmts: Stmt[]): Stmt => find(stmts, /INSERT INTO run_retry_operations/);

describe('retryRun operation key', () => {
  it('locks the source in canonical order, then records the operation after its run', async () => {
    const { pool, stmts } = makePool();
    const res = await retryRun(pool, 'run_src', DEFAULT_NAMESPACE, { operationKey: 'k-1' });

    // Canonical lock order: queue row first, then the runs row (FOR UPDATE).
    const queueLock = find(stmts, /FROM queue WHERE run_id/);
    expect(queueLock.sql).toMatch(/FOR UPDATE/);
    const runsLock = find(stmts, /FROM runs WHERE id/);
    expect(runsLock.sql).toMatch(/FOR UPDATE/);
    // The probe is a locked read, the INSERT binds the key and the new run id.
    const probe = find(stmts, /SELECT retry_run_id FROM run_retry_operations/);
    expect(probe.sql).toMatch(/FOR UPDATE/);
    expect(opInsert(stmts).params).toEqual([
      'default',
      'prod',
      'run_src',
      'k-1',
      res.runId,
    ]);
    // The operation row lands after its run was created (FK to runs).
    expect(stmts.findIndex((s) => /INSERT INTO runs/.test(s.sql))).toBeLessThan(
      stmts.indexOf(opInsert(stmts)),
    );
    // The work notification follows the operation insert (delivered at COMMIT).
    expect(stmts.findIndex((s) => /pg_notify/.test(s.sql))).toBeGreaterThan(
      stmts.indexOf(opInsert(stmts)),
    );
  });

  it('a replayed key returns the recorded run id and creates nothing', async () => {
    const { pool, stmts } = makePool({ opRow: { retry_run_id: 'run_prev' } });
    const res = await retryRun(pool, 'run_src', DEFAULT_NAMESPACE, { operationKey: 'k-replay' });

    expect(res.runId).toBe('run_prev');
    expect(stmts.some((s) => /INSERT/.test(s.sql))).toBe(false);
    expect(stmts.some((s) => /pg_notify/.test(s.sql))).toBe(false);
  });

  it('a unique violation on the operation PK rolls back and returns the winner id from the read-back (defense-in-depth)', async () => {
    const violation = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: OP_PK_CONSTRAINT,
    });
    const { pool, stmts } = makePool({
      opInsertError: violation,
      winner: { retry_run_id: 'run_winner' },
    });

    const res = await retryRun(pool, 'run_src', DEFAULT_NAMESPACE, { operationKey: 'k-race' });

    expect(res.runId).toBe('run_winner');
    // The read-back happened on a fresh connection after the tx aborted…
    expect(stmts.filter((s) => /SELECT retry_run_id FROM run_retry_operations/.test(s.sql))).toHaveLength(2);
    // …and nothing notified: the whole transaction rolled back.
    expect(stmts.some((s) => /pg_notify/.test(s.sql))).toBe(false);
  });

  it('a 23505 on any OTHER constraint is rethrown untouched (not a retry-operation race)', async () => {
    const violation = Object.assign(new Error('duplicate key on something else'), {
      code: '23505',
      constraint: 'runs_task_idempotency_uniq',
    });
    const { pool } = makePool({ opInsertError: violation });

    await expect(
      retryRun(pool, 'run_src', DEFAULT_NAMESPACE, { operationKey: 'k-other' }),
    ).rejects.toBe(violation);
  });

  it('a unique violation without a constraint name is rethrown untouched', async () => {
    const violation = Object.assign(new Error('duplicate key'), { code: '23505' });
    const { pool } = makePool({ opInsertError: violation });

    await expect(
      retryRun(pool, 'run_src', DEFAULT_NAMESPACE, { operationKey: 'k-noname' }),
    ).rejects.toBe(violation);
  });

  it('a read-back that finds no winner surfaces a stable conflict carrying the pg message', async () => {
    const violation = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: OP_PK_CONSTRAINT,
    });
    const { pool, stmts } = makePool({ opInsertError: violation });

    const attempt = retryRun(pool, 'run_src', DEFAULT_NAMESPACE, { operationKey: 'k-vanished' });
    await expect(attempt).rejects.toMatchObject({ code: 'conflict' });
    await expect(attempt).rejects.toThrow(/duplicate key value violates unique constraint/);
    // The read-back still happened after the rollback.
    expect(stmts.filter((s) => /SELECT retry_run_id FROM run_retry_operations/.test(s.sql))).toHaveLength(2);
  });

  it('without a key there is no operation SQL at all (legacy semantics)', async () => {
    const { pool, stmts } = makePool();
    await retryRun(pool, 'run_src', DEFAULT_NAMESPACE);

    expect(stmts.some((s) => /run_retry_operations/.test(s.sql))).toBe(false);
    expect(stmts.some((s) => /pg_notify/.test(s.sql))).toBe(true);
  });
});
