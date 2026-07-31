/* =============================================================================
   @better-trigger/kernel — data retention (todos/02-performance.md PF6).

   `prune()` is the only code in the engine that deletes history, which makes
   the interesting properties negative ones: what it must NOT delete, and what
   `--dry-run` must not do. Pinned here against a stub client (no Postgres), by
   reading the statements it issues:

     - --dry-run issues no DELETE at all, and still reports real numbers;
     - only terminal runs are candidates, whatever their age;
     - the age used is COALESCE(finished_at, updated_at), not created_at — a run
       that has been *running* for 40 days is not old, it is stuck;
     - deletion is batched, and the loop ends;
     - `runs` is the only table the run-side delete names besides the two the FK
       cascade cannot cover (waits / queue) — steps and logs go through the
       0007 cascade, not through hand-written SQL that could drift from it;
     - workers: offline only, and never a merely-stale online row;
     - a retention window under MIN_RETENTION_MS is refused rather than obeyed.

   The live-Postgres half — that the cascade actually fires — is
   examples/basic/scripts/retention.ts, run by `bun run test:acceptance`.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { KernelError } from '@better-trigger/core';
import { MIN_RETENTION_MS, prune } from '../src/prune';

interface Stmt {
  sql: string;
  params: unknown[];
}

/**
 * Answers the reads prune makes and records every statement. `runIds` is the
 * pool of prunable run ids; the candidate SELECT hands them out in batches of
 * whatever LIMIT it was given, and each DELETE FROM runs removes them for real,
 * so the batching loop terminates the same way it does against Postgres.
 */
function stubPool(runIds: string[] = []) {
  const stmts: Stmt[] = [];
  let remaining = [...runIds];

  const query = async (sql: string, params: unknown[] = []) => {
    stmts.push({ sql, params });
    // First: the dry-run roll-up embeds the candidate SELECT and names the same
    // count columns as the per-batch one, so the specific pattern goes on top.
    if (/^\s*WITH doomed AS/.test(sql)) {
      return {
        rows: [{ runs: '4', run_steps: '9', logs: '40', waits: '1', queue: '0' }],
        rowCount: 0,
      };
    }
    if (/SELECT r\.id FROM runs r/.test(sql)) {
      const limit = Number(params[2] ?? 0);
      return { rows: remaining.slice(0, limit).map((id) => ({ id })), rowCount: 0 };
    }
    if (/AS run_steps/.test(sql) && /AS logs/.test(sql)) {
      return { rows: [{ run_steps: '3', logs: '7' }], rowCount: 0 };
    }
    if (/count\(\*\) AS count FROM workers/.test(sql)) {
      return { rows: [{ count: '5' }], rowCount: 0 };
    }
    if (/^DELETE FROM runs/.test(sql)) {
      const ids = (params[0] as string[] | undefined) ?? [];
      remaining = remaining.filter((id) => !ids.includes(id));
      return { rows: [], rowCount: ids.length };
    }
    return { rows: [], rowCount: 2 };
  };

  const client = { query, release: () => {} };
  const pool = { connect: async () => client, query } as unknown as Pool;
  return { pool, stmts };
}

const deletes = (stmts: Stmt[]) => stmts.filter((s) => /^\s*DELETE/i.test(s.sql));
const find = (stmts: Stmt[], re: RegExp) => stmts.find((s) => re.test(s.sql));

const RETENTION = 30 * 86_400_000; // 30d

describe('prune --dry-run', () => {
  it('issues no DELETE whatsoever', async () => {
    const { pool, stmts } = stubPool(['r1', 'r2']);

    const res = await prune(pool, { olderThanMs: RETENTION, dryRun: true });

    expect(deletes(stmts)).toEqual([]);
    expect(res.dryRun).toBe(true);
    // Nor does it open a transaction it could delete inside of.
    expect(stmts.some((s) => /BEGIN/.test(s.sql))).toBe(false);
  });

  it('still reports what a real run would remove, per table', async () => {
    const { pool } = stubPool();

    const res = await prune(pool, { olderThanMs: RETENTION, dryRun: true });

    expect(res.runs).toBe(4);
    expect(res.runSteps).toBe(9);
    expect(res.logs).toBe(40);
    expect(res.waits).toBe(1);
    expect(res.queue).toBe(0);
    expect(res.workers).toBe(5);
  });
});

describe('prune candidate selection', () => {
  it('only considers terminal runs, and binds the status list', async () => {
    const { pool, stmts } = stubPool();

    await prune(pool, { olderThanMs: RETENTION });

    const candidate = find(stmts, /SELECT r\.id FROM runs r/)!;
    expect(candidate.sql).toMatch(/r\.status = ANY\(\$2::text\[\]\)/);
    expect(candidate.params[1]).toEqual(['completed', 'failed', 'canceled']);
    // queued / running / waiting are absent on purpose: a run stuck for a month
    // is a bug to look at, not garbage to collect.
    expect(candidate.params[1]).not.toContain('running');
  });

  it('ages runs by when they finished, never by when they were created', async () => {
    const { pool, stmts } = stubPool();

    await prune(pool, { olderThanMs: RETENTION });

    const candidate = find(stmts, /SELECT r\.id FROM runs r/)!;
    expect(candidate.sql).toMatch(/COALESCE\(r\.finished_at, r\.updated_at\) < \$1/);
    expect(candidate.sql).not.toMatch(/created_at/);
  });

  it('passes a cutoff that is exactly `olderThanMs` in the past', async () => {
    const { pool, stmts } = stubPool();
    const before = Date.now();

    const res = await prune(pool, { olderThanMs: RETENTION });

    const candidate = find(stmts, /SELECT r\.id FROM runs r/)!;
    const cutoff = candidate.params[0] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - RETENTION);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - RETENTION);
    expect(res.cutoff).toEqual(cutoff);
  });
});

describe('prune deletion', () => {
  it('deletes in batches and terminates', async () => {
    const { pool, stmts } = stubPool(['a', 'b', 'c', 'd', 'e']);

    const res = await prune(pool, { olderThanMs: RETENTION, batchSize: 2 });

    // 2 + 2 + 1 → the short batch ends the loop; a fourth pass would be a bug.
    const runDeletes = stmts.filter((s) => /^DELETE FROM runs/.test(s.sql));
    expect(runDeletes.map((s) => s.params[0])).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(res.runs).toBe(5);
    // Counted per batch, from the pre-delete count query (3 steps / 7 logs).
    expect(res.runSteps).toBe(9);
    expect(res.logs).toBe(21);
  });

  it('leaves steps and logs to the foreign-key cascade', async () => {
    const { pool, stmts } = stubPool(['a']);

    await prune(pool, { olderThanMs: RETENTION });

    // If prune ever grew its own `DELETE FROM logs`, the cascade and the CLI
    // would be two definitions of "delete a run" free to drift apart.
    const deleted = deletes(stmts).map((s) => s.sql);
    expect(deleted.some((sql) => /DELETE FROM logs/.test(sql))).toBe(false);
    expect(deleted.some((sql) => /DELETE FROM run_steps/.test(sql))).toBe(false);
    // waits / queue have no FK to runs, so those two ARE deleted by hand.
    expect(deleted.some((sql) => /DELETE FROM waits WHERE run_id/.test(sql))).toBe(true);
    expect(deleted.some((sql) => /DELETE FROM queue WHERE run_id/.test(sql))).toBe(true);
  });

  it('runs each batch in its own transaction', async () => {
    const { pool, stmts } = stubPool(['a', 'b']);

    await prune(pool, { olderThanMs: RETENTION, batchSize: 1 });

    expect(stmts.filter((s) => s.sql === 'BEGIN')).toHaveLength(3); // 2 + the empty one
    expect(stmts.filter((s) => s.sql === 'COMMIT')).toHaveLength(3);
  });

  it('does the run side and the worker side under the same cutoff', async () => {
    const { pool, stmts } = stubPool(['a']);

    await prune(pool, { olderThanMs: RETENTION });

    const workers = find(stmts, /DELETE FROM workers/)!;
    const candidate = find(stmts, /SELECT r\.id FROM runs r/)!;
    expect(workers.params[0]).toEqual(candidate.params[0]);
  });
});

describe('prune workers', () => {
  it('deletes offline rows only, past the cutoff', async () => {
    const { pool, stmts } = stubPool();

    await prune(pool, { olderThanMs: RETENTION });

    const workers = find(stmts, /DELETE FROM workers/)!;
    // A merely stale *online* row belongs to the offline-marker loop; deleting
    // it here would erase a daemon that is in fact still running.
    expect(workers.sql).toMatch(/status = 'offline'/);
    expect(workers.sql).toMatch(/last_heartbeat_at < \$1/);
  });
});

describe('prune retention floor', () => {
  it('refuses a window under the floor instead of obeying it', async () => {
    const { pool, stmts } = stubPool(['a']);

    // `--older-than 0` would delete the run whose result a client is still
    // polling for, which is never what anyone means by it.
    await expect(prune(pool, { olderThanMs: 0 })).rejects.toBeInstanceOf(KernelError);
    await expect(prune(pool, { olderThanMs: MIN_RETENTION_MS - 1 })).rejects.toThrow(
      /at least/,
    );
    expect(stmts).toEqual([]);
  });

  it('accepts exactly the floor', async () => {
    const { pool } = stubPool();
    await expect(prune(pool, { olderThanMs: MIN_RETENTION_MS })).resolves.toBeDefined();
  });
});
