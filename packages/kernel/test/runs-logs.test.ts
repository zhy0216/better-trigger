/* =============================================================================
   @better-trigger/kernel — log appends serialize against the terminal write
   through the run row lock, and terminal runs stop absorbing them (p2-40).

   appendLogs used to ride the liveness test on a single INSERT:
   `WHERE EXISTS (... finished_at IS NULL)` — one round trip, but with a
   snapshot window: the statement could pass the EXISTS test before a
   concurrent terminal tx committed, then block on the logs→runs FK and insert
   after finished_at existed. Each chunk is now its own short transaction:
   BEGIN → `SELECT finished_at ... FOR UPDATE` → INSERT (only when the locked
   row is still non-terminal) → COMMIT. The lock decides the boundary; there
   is no snapshot-then-wait-on-FK window left.

   The stub plays exactly those statements: the lock SELECT answers like pg
   would (run present + finished_at set → terminal; no row → missing; else
   alive) and the INSERT records every statement it is handed; no Postgres.
   ============================================================================= */
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '@better-trigger/core';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { appendLogs } from '../src/runs';
import type { KernelLogger } from '../src/kernel';

afterEach(() => {
  // The over-cap test tunes this env; keep it from leaking across suites.
  delete process.env.BETTER_TRIGGER_LOG_BATCH_MAX_BYTES;
});

interface Stmt {
  sql: string;
  params: unknown[];
}

/** 5 bind params per log row, plus the shared run id at $1 (+ ns at $2/$3). */
const PARAMS_PER_ROW = 5;

/**
 * A pool that plays the statements appendLogs issues. `finished` stands for
 * the run's finished_at being set; `missing` for the run not existing at all.
 * The lock SELECT answers like pg: alive → `[{finished_at: null}]`, terminal →
 * `[{finished_at: date}]`, missing → no rows. The INSERT is recorded but
 * returns nothing.
 */
const makePool = (
  run: { finished?: boolean; missing?: boolean; finishAfterChunks?: number } = {},
) => {
  const stmts: Stmt[] = [];
  const inserted: { runId: string; rows: number }[] = [];
  const warns: string[] = [];
  let inserts = 0;
  const query = async (sql: string, params: unknown[] = []) => {
    stmts.push({ sql, params });
    if (/^BEGIN/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/^SELECT finished_at/.test(sql)) {
      // The guard is the whole point of the statement: if a future edit drops
      // the FOR UPDATE, the stub must not keep pretending terminal runs are
      // protected.
      const locked = /FOR UPDATE\s*$/m.test(sql);
      if (!locked) throw new Error('appendLogs lock SELECT lost its FOR UPDATE');
      if (run.missing) return { rows: [], rowCount: 0 };
      return {
        rows: run.finished ? [{ finished_at: new Date('2026-07-30T01:00:00.000Z') }] : [{ finished_at: null }],
        rowCount: 1,
      };
    }
    if (/^INSERT INTO logs/.test(sql)) {
      // $1 run id + $2/$3 namespace are shared; row params start at $4.
      const rows = (params.length - 3) / PARAMS_PER_ROW;
      inserts += 1;
      inserted.push({ runId: params[0] as string, rows });
      if (run.finishAfterChunks !== undefined && inserts >= run.finishAfterChunks) {
        run.finished = true;
      }
      return { rows: [], rowCount: rows };
    }
    throw new Error(`stub cannot answer: ${sql}`);
  };
  const client = { query, release: async () => {} };
  const pool = {
    connect: async () => client,
    query,
  } as unknown as Pool;
  const logger: KernelLogger = {
    warn: (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    },
    error: () => {},
  };
  return { pool, stmts, inserted, warns, logger };
};

const entry = (message: string): LogEntry => ({
  ts: '2026-07-30T00:00:00.000Z',
  level: 'info',
  message,
});

const entries = (n: number): LogEntry[] =>
  Array.from({ length: n }, (_, i) => entry(`line ${i}`));

/** The statements of one chunk: BEGIN, lock SELECT, INSERT, COMMIT. */
const chunkShape = (stmts: Stmt[]): { select: Stmt; insert: Stmt }[] => {
  const shapes: { select: Stmt; insert: Stmt }[] = [];
  let select: Stmt | null = null;
  for (const s of stmts) {
    if (/^SELECT finished_at/.test(s.sql)) select = s;
    else if (select && /^INSERT INTO logs/.test(s.sql)) {
      shapes.push({ select, insert: s });
      select = null;
    }
  }
  return shapes;
};

describe('appendLogs', () => {
  it('locks the run row first, then inserts — lock, decide, commit per chunk', async () => {
    const { pool, stmts } = makePool();
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, entries(3), undefined);

    // Exactly one chunk: BEGIN, lock SELECT, INSERT, COMMIT — nothing else.
    expect(stmts).toHaveLength(4);
    expect(stmts[0]!.sql).toBe('BEGIN');
    expect(stmts[1]!.sql).toMatch(/^SELECT finished_at FROM runs .*FOR UPDATE$/);
    expect(stmts[2]!.sql).toMatch(/^INSERT INTO logs /);
    expect(stmts[3]!.sql).toBe('COMMIT');
    const shapes = chunkShape(stmts);
    expect(shapes).toHaveLength(1);
    // The liveness decision is the lock SELECT, not a guard on the INSERT.
    expect(shapes[0]!.select.sql).toMatch(/FOR UPDATE/);
    expect(shapes[0]!.select.params).toEqual(['run_1', 'default', 'prod']);
    expect(shapes[0]!.insert.sql).not.toMatch(/EXISTS/);
    expect(shapes[0]!.insert.params[0]).toBe('run_1');
  });

  it('binds each line once, run id shared', async () => {
    const { pool, stmts } = makePool();
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, [
      { ts: '2026-07-30T00:00:00.000Z', level: 'warn', message: 'hi', stepSeq: 2, data: { a: 1 } },
    ]);

    const insert = stmts.find((s) => /^INSERT INTO logs/.test(s.sql))!;
    // run id once at $1, namespace at $2/$3, then the row's five columns.
    expect(insert.params).toEqual([
      'run_1',
      'default',
      'prod',
      2,
      'warn',
      'hi',
      '{"a":1}',
      '2026-07-30T00:00:00.000Z',
    ]);
  });

  it('writes nothing, and raises nothing, for a terminal run — and says so', async () => {
    const { pool, stmts, inserted, warns, logger } = makePool({ finished: true });
    // Must not throw: this is the flush of an executor that was fenced out, and
    // the executor's flush path treats a rejection as dropped-log diagnostics.
    await expect(
      appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, entries(3), logger),
    ).resolves.toBeUndefined();

    expect(inserted).toEqual([]);
    // Lock still taken (it IS the decision) — the INSERT never ran.
    expect(stmts.some((s) => /^SELECT finished_at/.test(s.sql))).toBe(true);
    expect(stmts.some((s) => /^INSERT INTO logs/.test(s.sql))).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/\[runs:logs\] dropped 3 log line\(s\): run run_1 \(default\/prod\) already terminal/);
  });

  it('writes nothing, and raises nothing, for a run that no longer exists — distinct warn', async () => {
    const { pool, inserted, warns, logger } = makePool({ missing: true });
    await expect(
      appendLogs(pool, 'gone', DEFAULT_NAMESPACE, entries(2), logger),
    ).resolves.toBeUndefined();
    expect(inserted).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/\[runs:logs\] dropped 2 log line\(s\): run gone \(default\/prod\) does not exist/);
  });

  it('still chunks — one flush is not one giant INSERT, one lock per chunk', async () => {
    const { pool, stmts, inserted } = makePool();
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, entries(2500));

    const shapes = chunkShape(stmts);
    expect(shapes).toHaveLength(3);
    for (const s of shapes) {
      const rows = (s.insert.params.length - 3) / PARAMS_PER_ROW;
      expect(rows).toBeLessThanOrEqual(1000);
      // Every chunk takes its own lock, so a run that goes terminal mid-flush
      // stops absorbing the rest instead of half-writing past its own end.
      expect(s.select.sql).toMatch(/FOR UPDATE/);
      expect(s.insert.params[0]).toBe('run_1');
      // Comfortably under pg's 65535 bind-param ceiling, which is why chunks
      // exist in the first place.
      expect(s.insert.params.length).toBeLessThan(65535);
    }
    expect(inserted.reduce((n, i) => n + i.rows, 0)).toBe(2500);
  });

  it('a run that goes terminal mid-flush absorbs only the chunks before the boundary', async () => {
    const { pool, inserted, warns, logger } = makePool({ finishAfterChunks: 2 });
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, entries(2500), logger);

    const landed = inserted.reduce((n, i) => n + i.rows, 0);
    expect(landed).toBe(2000);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/dropped 500 log line\(s\).*already terminal/);
  });

  it('issues no statement at all for an empty flush', async () => {
    const { pool, stmts } = makePool();
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, []);
    expect(stmts).toEqual([]);
  });

  it('drops a bad-level / bad-ts line with a warn and writes the rest of the batch', async () => {
    // Worker messages arrive as JSON: a line whose level is outside
    // logs_level_check or whose ts pg cannot cast to timestamptz used to fail
    // the whole chunk INSERT at the database (a bare 23514/22007 that rolled
    // the flush's good lines back with it). Preparation filters them out
    // instead — the flush still resolves, the good lines still land.
    const { pool, stmts, inserted, warns, logger } = makePool();
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, [
      entry('good 1'),
      { ts: '2026-07-30T00:00:00.000Z', level: 'trace' as LogEntry['level'], message: 'bad level' },
      { ts: 'next tuesday-ish', level: 'info', message: 'bad ts' },
      entry('good 2'),
    ], logger);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.rows).toBe(2);
    // Only the two good lines reach the VALUES list — the bad pair never
    // makes it anywhere near a cast or a CHECK.
    const insert = stmts.find((s) => /^INSERT INTO logs/.test(s.sql))!;
    const messages = insert.params.filter((p) => typeof p === 'string' && /^good \d$/.test(p));
    expect(messages).toEqual(['good 1', 'good 2']);
    expect(insert.params).not.toContain('bad level');
    expect(insert.params).not.toContain('bad ts');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/dropped 2 log line\(s\).*bad level or ts/);
    expect(warns[0]).toMatch(/debug\/info\/warn\/error/);
  });

  it('a flush of only-bad lines writes nothing and still never throws', async () => {
    const { pool, stmts, inserted, warns, logger } = makePool();
    await expect(
      appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, [
        { ts: 'soon', level: 'verbose' as LogEntry['level'], message: 'nope' },
      ], logger),
    ).resolves.toBeUndefined();
    expect(inserted).toEqual([]);
    expect(stmts).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  it('drops — with a warn, never silently — a line that cannot fit the batch cap even after truncation', async () => {
    // A cap smaller than the smallest possible line: even shrinkRowForBatch's
    // degraded row (data omitted + message trimmed to the ellipsis) exceeds
    // it, so the line cannot be written at all.
    process.env.BETTER_TRIGGER_LOG_BATCH_MAX_BYTES = '80';
    const { pool, stmts, inserted, warns, logger } = makePool();
    await appendLogs(pool, 'run_1', DEFAULT_NAMESPACE, entries(1), logger);

    expect(inserted).toEqual([]);
    // Nothing left to chunk — no transaction is opened at all.
    expect(stmts).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(
      /\[runs:logs\] dropped 1 log line\(s\): each exceeds the log batch cap/,
    );
    expect(warns[0]).toMatch(/BETTER_TRIGGER_LOG_BATCH_MAX_BYTES/);
  });
});
