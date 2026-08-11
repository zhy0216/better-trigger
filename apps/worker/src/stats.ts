/* =============================================================================
   @better-trigger/worker — task statistics aggregation.
   Computes per-task: runs24h, p50/p95 duration (percentile_cont over finished
   runs), successRate (0-100), and a 12×2h run-count trend over the last 24h.
   Three SQL passes in parallel (24h agg, trend, all-history lastRunAt),
   joined onto tasks in routes/dashboard.ts.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Namespace } from '@better-trigger/core';

export interface TaskStats {
  taskId: string;
  /** Runs created within the last 24h. */
  runs24h: number;
  /** p50 duration in ms over runs CREATED within the last 24h (finished only). */
  p50Ms: number | null;
  /** p95 duration in ms over runs CREATED within the last 24h (finished only). */
  p95Ms: number | null;
  /** 0–100 share of 24h-window finished runs that completed; null when none. */
  successRate: number | null;
  /** 12 buckets, oldest first (bucket 0 = 22-24h ago, bucket 11 = 0-2h ago). */
  trend: number[];
  /** The task's most recent run over ALL history — not just the 24h window. */
  lastRunAt: string | null;
}

const EMPTY_TREND = () => new Array<number>(12).fill(0);

/**
 * The one 24h window every stats metric (and the trend) shares, as a single
 * literal so the queries cannot drift apart. The agg query uses it twice:
 *
 *  - in its WHERE clause, which bounds the scan to the window — served by
 *    runs_created_idx (project_id, env, created_at), so the query's cost is
 *    proportional to a day of runs, not to all of history;
 *  - in every per-aggregate FILTER, which declare each metric's window
 *    explicitly and independently of the outer scan bound.
 */
const RUNS_24H_WINDOW = `r.created_at >= now() - interval '24 hours'`;

/**
 * Aggregate stats for all tasks in one namespace; returns a map keyed by task
 * id. Every aggregate predicates on (project_id, env) — a dashboard pointed at
 * default/prod never sees another namespace's runs, whatever their task ids
 * (C2).
 *
 * Three queries, run in parallel:
 *
 *  - agg: the 24h-window metrics (runs24h, p50/p95, successRate). A task with
 *    no runs in the window is simply absent from the GROUP BY result — the
 *    percentile aggregation is one pass over the windowed rows, never one
 *    query per task (the "no-run task must not trigger a full-table percentile
 *    scan" property of PF1).
 *  - trend: 12×2h run-count buckets over the same 24h window.
 *  - lastRun: the task's most recent run over ALL history, kept separate so
 *    the all-history scan never drags on the windowed metrics. Tasks whose
 *    only runs predate the window appear here but not in agg; they are seeded
 *    with zero/null 24h stats.
 */
export async function computeTaskStats(
  pool: Pool,
  namespace: Namespace,
): Promise<Map<string, TaskStats>> {
  const [agg, trend, lastRun] = await Promise.all([
    pool.query<{
      task_id: string;
      runs24h: string;
      p50: number | null;
      p95: number | null;
      success: string;
      finished_total: string;
    }>(
      `SELECT
          r.task_id,
          count(*) FILTER (WHERE ${RUNS_24H_WINDOW}) AS runs24h,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000
          ) FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL AND ${RUNS_24H_WINDOW}) AS p50,
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000
          ) FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL AND ${RUNS_24H_WINDOW}) AS p95,
          count(*) FILTER (WHERE r.status = 'completed' AND ${RUNS_24H_WINDOW}) AS success,
          count(*) FILTER (WHERE r.status IN ('completed','failed','canceled') AND ${RUNS_24H_WINDOW}) AS finished_total
         FROM runs r
        WHERE r.project_id = $1 AND r.env = $2
          AND ${RUNS_24H_WINDOW}
        GROUP BY r.task_id`,
      [namespace.projectId, namespace.env],
    ),
    pool.query<{ task_id: string; bucket: number; n: string }>(
      `SELECT
          r.task_id,
          floor(EXTRACT(EPOCH FROM (now() - r.created_at)) / 7200)::int AS bucket,
          count(*)                                                       AS n
         FROM runs r
        WHERE ${RUNS_24H_WINDOW}
          AND r.project_id = $1 AND r.env = $2
        GROUP BY r.task_id, bucket`,
      [namespace.projectId, namespace.env],
    ),
    pool.query<{ task_id: string; last_run_at: Date | null }>(
      `SELECT r.task_id, max(r.created_at) AS last_run_at
         FROM runs r
        WHERE r.project_id = $1 AND r.env = $2
        GROUP BY r.task_id`,
      [namespace.projectId, namespace.env],
    ),
  ]);

  const out = new Map<string, TaskStats>();
  for (const row of agg.rows) {
    const finishedTotal = Number(row.finished_total);
    out.set(row.task_id, {
      taskId: row.task_id,
      runs24h: Number(row.runs24h),
      p50Ms: row.p50 != null ? Math.round(row.p50) : null,
      p95Ms: row.p95 != null ? Math.round(row.p95) : null,
      successRate:
        finishedTotal > 0 ? Math.round((Number(row.success) / finishedTotal) * 100) : null,
      trend: EMPTY_TREND(),
      lastRunAt: null,
    });
  }

  for (const row of trend.rows) {
    const stats = out.get(row.task_id);
    if (!stats) continue;
    const bucket = Number(row.bucket);
    if (bucket < 0 || bucket > 11) continue;
    // bucket 0 = most recent 2h → place oldest first (index 11 = most recent).
    stats.trend[11 - bucket] = Number(row.n);
  }

  for (const row of lastRun.rows) {
    const lastRunAt = row.last_run_at ? row.last_run_at.toISOString() : null;
    const stats = out.get(row.task_id);
    if (stats) {
      stats.lastRunAt = lastRunAt;
    } else {
      // Runs only older than the window: keep the all-history lastRunAt, and
      // let the 24h metrics fall back to zero/null (same rendering as a task
      // with no runs at all).
      out.set(row.task_id, {
        taskId: row.task_id,
        runs24h: 0,
        p50Ms: null,
        p95Ms: null,
        successRate: null,
        trend: EMPTY_TREND(),
        lastRunAt,
      });
    }
  }

  return out;
}
