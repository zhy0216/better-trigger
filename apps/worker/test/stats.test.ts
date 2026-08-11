/* =============================================================================
   @better-trigger/worker — computeTaskStats time-window semantics (PF1,
   todos/02-performance.md).

   The stats aggregations used to read the whole runs table: only runs24h had
   a 24h FILTER, so p50/p95/successRate were all-time numbers wearing a
   "last 24h" label, and cost grew with every historical run. What is pinned
   here is the SQL shape (the window in the scan bound AND in every aggregate
   FILTER, lastRunAt in its own all-history query) plus the row mapping, so
   the window can never silently drift back to all-time again.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Namespace } from '@better-trigger/core';
import { describe, expect, it } from 'vitest';
import { computeTaskStats } from '../src/stats';

const NS: Namespace = { projectId: 'acme', env: 'staging' };

interface Stmt {
  sql: string;
  params: unknown[];
}

/** The window literal exactly as stats.ts emits it (alias `r`). */
const WINDOW = `r.created_at >= now() - interval '24 hours'`;

/** Fake pool capturing statements; rowsFor(sql) picks the response per query. */
function poolWith(rowsFor: (sql: string) => unknown[]): { pool: Pool; stmts: Stmt[] } {
  const stmts: Stmt[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      return { rows: rowsFor(sql) };
    },
  } as unknown as Pool;
  return { pool, stmts };
}

describe('computeTaskStats — 24h window semantics', () => {
  it('puts the 24h window in the scan bound AND in every aggregate FILTER', async () => {
    const { pool, stmts } = poolWith(() => []);
    await computeTaskStats(pool, NS);

    const agg = stmts.find((s) => s.sql.includes('percentile_cont'));
    expect(agg).toBeDefined();
    // The window literal appears once per metric's FILTER (runs24h, p50, p95,
    // success, finished_total) plus once in the WHERE scan bound = 6.
    expect(
      agg!.sql.match(new RegExp(`created_at >= now\\(\\) - interval '24 hours'`, 'g')),
    ).toHaveLength(6);
    // And each FILTER carries the window on its own — an edit that narrows one
    // metric back to all-time (the pre-PF1 drift) fails right here.
    expect(agg!.sql).toContain(`FILTER (WHERE ${WINDOW})`);
    expect(agg!.sql).toContain(
      `FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL AND ${WINDOW})`,
    );
    expect(agg!.sql).toContain(`FILTER (WHERE r.status = 'completed' AND ${WINDOW})`);
    expect(agg!.sql).toContain(
      `FILTER (WHERE r.status IN ('completed','failed','canceled') AND ${WINDOW})`,
    );
    // The scan is namespace-scoped and bounded to the window.
    expect(agg!.sql).toContain('WHERE r.project_id = $1 AND r.env = $2');
    expect(agg!.sql).toContain(`AND ${WINDOW}`);
    expect(agg!.params).toEqual(['acme', 'staging']);

    // The trend query shares the same window literal (agg and trend cannot
    // drift apart).
    const trend = stmts.find((s) => s.sql.includes('bucket'));
    expect(trend).toBeDefined();
    expect(trend!.sql).toContain(WINDOW);

    // lastRunAt is its own query over ALL history — no window, no percentile —
    // and the windowed agg no longer computes it.
    const lastRun = stmts.find((s) => s.sql.includes('max(r.created_at)'));
    expect(lastRun).toBeDefined();
    expect(lastRun!.sql).not.toContain('percentile_cont');
    expect(lastRun!.sql).not.toContain('24 hours');
    expect(lastRun!.sql).toContain('WHERE r.project_id = $1 AND r.env = $2');
    expect(agg!.sql).not.toContain('last_run_at');
  });

  it('maps windowed rows onto TaskStats, rounding p50/p95 and computing successRate', async () => {
    const { pool } = poolWith((sql) => {
      if (sql.includes('percentile_cont')) {
        return [
          {
            task_id: 't1',
            runs24h: '4',
            p50: 12.34,
            p95: 99.6,
            success: '3',
            finished_total: '4',
          },
        ];
      }
      if (sql.includes('bucket')) {
        return [
          { task_id: 't1', bucket: 3, n: '2' },
          { task_id: 't1', bucket: 11, n: '5' },
        ];
      }
      if (sql.includes('max(r.created_at)')) {
        return [
          { task_id: 't1', last_run_at: new Date('2026-08-10T10:00:00.000Z') },
          // A task whose only runs predate the 24h window: it is absent from
          // the windowed agg but present here, and must keep its lastRunAt.
          { task_id: 't1-old', last_run_at: new Date('2026-01-01T00:00:00.000Z') },
        ];
      }
      return [];
    });
    const stats = await computeTaskStats(pool, NS);

    expect(stats.get('t1')).toEqual({
      taskId: 't1',
      runs24h: 4,
      p50Ms: 12,
      p95Ms: 100,
      successRate: 75,
      // bucket 11 (most recent 2h) → index 0; bucket 3 → index 8.
      trend: [5, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0],
      lastRunAt: '2026-08-10T10:00:00.000Z',
    });
    // Old-only task: 24h stats fall back to zero/null, lastRunAt kept.
    expect(stats.get('t1-old')).toEqual({
      taskId: 't1-old',
      runs24h: 0,
      p50Ms: null,
      p95Ms: null,
      successRate: null,
      trend: new Array(12).fill(0),
      lastRunAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('keeps successRate null while no windowed run has finished', async () => {
    const { pool } = poolWith((sql) => {
      if (sql.includes('percentile_cont')) {
        return [
          {
            task_id: 't2',
            runs24h: '2',
            p50: null,
            p95: null,
            success: '0',
            finished_total: '0',
          },
        ];
      }
      return [];
    });
    const stats = await computeTaskStats(pool, NS);
    expect(stats.get('t2')).toMatchObject({
      runs24h: 2,
      p50Ms: null,
      p95Ms: null,
      successRate: null,
    });
  });

  it('keeps 24h-outside runs out of the windowed metrics (row-level behaviour)', async () => {
    // What Postgres returns for a task with BOTH windowed runs and runs from
    // 26h ago: the windowed aggregations over the in-window rows only, plus
    // the all-history lastRunAt. If the window ever stopped filtering, the
    // 26h-old 999-second runs would dominate p50/p95 and widen successRate's
    // denominator — the row values below are what only-the-window can
    // produce, and they must survive the mapping unchanged.
    const { pool } = poolWith((sql) => {
      if (sql.includes('percentile_cont')) {
        return [
          {
            task_id: 'mixed',
            runs24h: '4', // 3 completed + 1 failed, all created within the window
            p50: 8, // fast windowed runs only — not the 999s historical ones
            p95: 42,
            success: '3',
            finished_total: '4',
          },
        ];
      }
      if (sql.includes('max(r.created_at)')) {
        return [
          {
            task_id: 'mixed',
            last_run_at: new Date('2026-08-10T10:00:00.000Z'), // 26h before the window
          },
        ];
      }
      return [];
    });
    const stats = await computeTaskStats(pool, NS);

    expect(stats.get('mixed')).toEqual({
      taskId: 'mixed',
      runs24h: 4,
      p50Ms: 8,
      p95Ms: 42,
      successRate: 75, // 3/4 windowed — 7/8 all-time would round to 88
      trend: new Array(12).fill(0),
      lastRunAt: '2026-08-10T10:00:00.000Z', // all-history, untouched by the window
    });
  });

  it('issues the three queries concurrently, not serially', async () => {
    const issued: string[] = [];
    const gate = new Map<string, () => void>();
    const pool = {
      query: (sql: string) => {
        const which = sql.includes('percentile_cont')
          ? 'agg'
          : sql.includes('bucket')
            ? 'trend'
            : 'lastRun';
        issued.push(which);
        return new Promise((resolve) => {
          gate.set(which, () => resolve({ rows: [] }));
        });
      },
    } as unknown as Pool;
    const pending = computeTaskStats(pool, NS);
    // All three queries are in flight before any of them resolves.
    expect(issued.sort()).toEqual(['agg', 'lastRun', 'trend']);
    for (const key of [...gate.keys()]) gate.get(key)!();
    await pending;
  });
});
