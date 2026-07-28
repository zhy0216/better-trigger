/* =============================================================================
   @better-trigger/server — task statistics aggregation.
   Computes per-task: runs24h, p50/p95 duration (percentile_cont over finished
   runs), successRate (0-100), and a 12×2h run-count trend over the last 24h.
   One SQL pass per metric group; joined onto tasks in routes/dashboard.ts.
   ============================================================================= */
import type { Pool } from 'pg';

export interface TaskStats {
  taskId: string;
  runs24h: number;
  p50Ms: number | null;
  p95Ms: number | null;
  successRate: number | null;
  /** 12 buckets, oldest first (bucket 0 = 22-24h ago, bucket 11 = 0-2h ago). */
  trend: number[];
  lastRunAt: string | null;
}

const EMPTY_TREND = () => new Array<number>(12).fill(0);

/** Aggregate stats for all tasks in one go; returns a map keyed by task id. */
export async function computeTaskStats(pool: Pool): Promise<Map<string, TaskStats>> {
  // Aggregate metrics over the last 24h window per task.
  const agg = await pool.query<{
    task_id: string;
    runs24h: string;
    p50: number | null;
    p95: number | null;
    success: string;
    finished_total: string;
    last_run_at: Date | null;
  }>(
    `SELECT
        r.task_id,
        count(*) FILTER (WHERE r.created_at >= now() - interval '24 hours')                AS runs24h,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000
        ) FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL)             AS p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000
        ) FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL)             AS p95,
        count(*) FILTER (WHERE r.status = 'completed')                                      AS success,
        count(*) FILTER (WHERE r.status IN ('completed','failed','canceled'))               AS finished_total,
        max(r.created_at)                                                                   AS last_run_at
       FROM runs r
      GROUP BY r.task_id`,
  );

  // 12×2h buckets of run counts over the last 24h, per task.
  const trend = await pool.query<{ task_id: string; bucket: number; n: string }>(
    `SELECT
        r.task_id,
        floor(EXTRACT(EPOCH FROM (now() - r.created_at)) / 7200)::int AS bucket,
        count(*)                                                       AS n
       FROM runs r
      WHERE r.created_at >= now() - interval '24 hours'
      GROUP BY r.task_id, bucket`,
  );

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
      lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
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

  return out;
}
