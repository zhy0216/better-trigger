/* =============================================================================
   @better-trigger/kernel — log appends are one statement, and terminal runs
   stop absorbing them (C8).

   appendLogs used to SELECT the run first and only then INSERT: an extra round
   trip on a path the executor walks once a second per in-flight run, and a check
   that said nothing about whether the run was still alive — so a fenced-out
   executor's flush landed *after* the run's own finished_at and made the history
   read as if the run kept going. Both are now one statement: the rows come from
   a VALUES sub-select gated by EXISTS (... finished_at IS NULL), which writes 0
   rows for a run that is gone or finished.

   The stub understands just enough of that statement to answer it like pg would
   (guard present + run alive → all rows land; otherwise none) and records every
   statement it is handed; no Postgres.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@better-trigger/core';
import { appendLogs } from '../src/runs';

interface Stmt {
  sql: string;
  params: unknown[];
}

/** 5 bind params per log row, plus the shared run id at $1. */
const PARAMS_PER_ROW = 5;

/**
 * A pool that plays the one statement appendLogs issues. `finished` stands for
 * the run's finished_at being set; `missing` for the run not existing at all —
 * appendLogs cannot tell those apart and neither does this stub, beyond both
 * failing the EXISTS test.
 */
const makePool = (run: { finished?: boolean; missing?: boolean } = {}) => {
  const stmts: Stmt[] = [];
  const inserted: { runId: string; rows: number }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      const rows = (params.length - 1) / PARAMS_PER_ROW;
      // The guard is the whole point of the statement: if a future edit drops
      // it, the stub must not keep pretending terminal runs are protected.
      const guarded = /EXISTS \(SELECT 1 FROM runs WHERE id = \$1 AND finished_at IS NULL\)/.test(
        sql,
      );
      const alive = !run.finished && !run.missing;
      const written = guarded && !alive ? 0 : rows;
      if (written > 0) inserted.push({ runId: params[0] as string, rows: written });
      return { rows: [], rowCount: written };
    },
  } as unknown as Pool;
  return { pool, stmts, inserted };
};

const entry = (message: string): LogEntry => ({
  ts: '2026-07-30T00:00:00.000Z',
  level: 'info',
  message,
});

const entries = (n: number): LogEntry[] =>
  Array.from({ length: n }, (_, i) => entry(`line ${i}`));

describe('appendLogs', () => {
  it('costs exactly one round trip — no existence SELECT', async () => {
    const { pool, stmts } = makePool();
    await appendLogs(pool, 'run_1', entries(3));

    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toMatch(/INSERT INTO logs/);
    // The old shape read the run first; nothing may reintroduce that.
    expect(stmts.some((s) => /^\s*SELECT/.test(s.sql))).toBe(false);
    // Existence and liveness are decided inside the INSERT instead.
    expect(stmts[0]!.sql).toMatch(/finished_at IS NULL/);
    expect(stmts[0]!.params[0]).toBe('run_1');
  });

  it('binds each line once, run id shared', async () => {
    const { pool, stmts } = makePool();
    await appendLogs(pool, 'run_1', [
      { ts: '2026-07-30T00:00:00.000Z', level: 'warn', message: 'hi', stepSeq: 2, data: { a: 1 } },
    ]);

    // run id once at $1, then the row's five columns in column order.
    expect(stmts[0]!.params).toEqual([
      'run_1',
      2,
      'warn',
      'hi',
      '{"a":1}',
      '2026-07-30T00:00:00.000Z',
    ]);
  });

  it('writes nothing, and raises nothing, for a terminal run', async () => {
    const { pool, stmts, inserted } = makePool({ finished: true });
    // Must not throw: this is the flush of an executor that was fenced out, and
    // the executor's flush path treats a rejection as dropped-log diagnostics.
    await expect(appendLogs(pool, 'run_1', entries(3))).resolves.toBeUndefined();

    expect(stmts).toHaveLength(1);
    expect(inserted).toEqual([]);
  });

  it('writes nothing, and raises nothing, for a run that no longer exists', async () => {
    const { pool, inserted } = makePool({ missing: true });
    await expect(appendLogs(pool, 'gone', entries(2))).resolves.toBeUndefined();
    expect(inserted).toEqual([]);
  });

  it('still chunks — one flush is not one giant INSERT', async () => {
    const { pool, stmts, inserted } = makePool();
    await appendLogs(pool, 'run_1', entries(2500));

    expect(stmts).toHaveLength(3);
    for (const s of stmts) {
      const rows = (s.params.length - 1) / PARAMS_PER_ROW;
      expect(rows).toBeLessThanOrEqual(1000);
      // Every chunk carries the guard, so a run that goes terminal mid-flush
      // stops absorbing the rest instead of half-writing past its own end.
      expect(s.sql).toMatch(/finished_at IS NULL/);
      expect(s.params[0]).toBe('run_1');
      // Comfortably under pg's 65535 bind-param ceiling, which is why chunks
      // exist in the first place.
      expect(s.params.length).toBeLessThan(65535);
    }
    expect(inserted.reduce((n, i) => n + i.rows, 0)).toBe(2500);
  });

  it('issues no statement at all for an empty flush', async () => {
    const { pool, stmts } = makePool();
    await appendLogs(pool, 'run_1', []);
    expect(stmts).toEqual([]);
  });
});
