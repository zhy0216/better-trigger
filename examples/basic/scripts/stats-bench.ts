/* =============================================================================
   @better-trigger/example-basic — /tasks stats query plan bench (PF1,
   todos/02-performance.md).

   The /tasks aggregation used to scan the whole runs table (only runs24h had
   a 24h FILTER), so with retention off its cost grew with every historical
   run. The fixed query bounds the scan to the window in its WHERE clause.
   This bench seeds a large runs table where 95% of the rows predate the
   24h window and reads `EXPLAIN (ANALYZE, BUFFERS)` of the aggregation
   twice: once with `runs_created_idx` (project_id, env, created_at) present
   and once with it dropped. The windowed scan must reach the table through
   that index and touch a small fraction of the buffers the unindexed plan
   needs.

   Checks, not just numbers:
     - the windowed aggregation is an Index Scan using runs_created_idx;
     - without the index it falls back to a Seq Scan over the whole table;
     - the index scan touches at least 4x fewer buffers.

   Runs on @better-trigger/testing: runScenario provisions + migrates the
   scenario's database and folds the verdict into the exit code. A live
   Postgres is required, so this is NOT part of `bun run test`, and it is not
   in scripts/acceptance.ts either — it is a bench, run it by hand after
   touching the stats query or the runs indexes:
     bun run bench:stats            # 1_000_000 historical rows
     BT_STATS_ROWS=200000 bun run bench:stats   # smaller/faster

   Env:
     DATABASE_URL    base connection derived from it; default
                     postgres://localhost:5432/better_trigger
     BT_STATS_BENCH_DB  override the provisioned database name
     BT_STATS_ROWS   total runs to seed (default 1_000_000)
   ============================================================================= */
import { runScenario, type Scenario } from '@better-trigger/testing';

/** Total runs to seed; 95% predate the 24h window. Override with BT_STATS_ROWS. */
const TOTAL = Number(process.env.BT_STATS_ROWS ?? 1_000_000);
/** Distinct tasks the runs are spread across. */
const TASKS = 16;
/** Share of runs created INSIDE the 24h window (the rest are 26h+ old). */
const WINDOWED = 0.05;

/**
 * Mirrors the main aggregation in apps/worker/src/stats.ts (computeTaskStats,
 * query 1). Kept as a copy on purpose: the worker does not export its SQL,
 * and EXPLAIN needs the statement text. If the stats query changes shape,
 * change it here too — a bench measuring a query nobody runs proves nothing.
 */
const STATS_SQL = `SELECT
        r.task_id,
        count(*) FILTER (WHERE r.created_at >= now() - interval '24 hours') AS runs24h,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000
        ) FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL
                  AND r.created_at >= now() - interval '24 hours') AS p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000
        ) FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL
                  AND r.created_at >= now() - interval '24 hours') AS p95,
        count(*) FILTER (WHERE r.status = 'completed'
                         AND r.created_at >= now() - interval '24 hours') AS success,
        count(*) FILTER (WHERE r.status IN ('completed','failed','canceled')
                         AND r.created_at >= now() - interval '24 hours') AS finished_total
   FROM runs r
  WHERE r.project_id = $1 AND r.env = $2
    AND r.created_at >= now() - interval '24 hours'
  GROUP BY r.task_id`;

interface Plan {
  text: string;
  buffers: number;
  ms: number;
}

async function explain(s: Scenario, label: string): Promise<Plan> {
  const res = await s.pool.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${STATS_SQL}`,
    ['default', 'prod'],
  );
  const text = res.rows.map((r) => r['QUERY PLAN']).join('\n');
  console.log(`\n----- ${label} -----\n${text}\n`);
  return {
    text,
    buffers: Number(text.match(/Buffers: shared hit=(\d+)/)?.[1] ?? 0),
    ms: Number(text.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? 0),
  };
}

async function main(s: Scenario): Promise<void> {
  // Nothing here is a post-mortem candidate: the data is synthetic and huge.
  s.cleanup(() => s.db.drop());

  const oldShare = Math.floor(TOTAL * (1 - WINDOWED));

  await s.pool.query(
    `INSERT INTO tasks (id, name, trigger_source)
       SELECT 'task-' || g, 'task ' || g, 'api' FROM generate_series(0, $1::int) g`,
    [TASKS - 1],
  );
  await s.pool.query(
    `INSERT INTO runs (id, task_id, status, trigger_type, attempt, max_attempts,
                       created_at, started_at, finished_at)
     SELECT 'run-' || g,
            'task-' || (g % $2::int),
            CASE WHEN g < $3::int THEN 'completed' ELSE CASE WHEN g % 4 = 0 THEN 'failed' ELSE 'completed' END END,
            'api', 1, 1,
            CASE WHEN g < $3::int THEN now() - interval '26 hours' - (g % 600 || ' minutes')::interval
                 ELSE now() - interval '1 hour' - (g % 60 || ' minutes')::interval END,
            CASE WHEN g < $3::int THEN now() - interval '26 hours' - (g % 600 || ' minutes')::interval
                 ELSE now() - interval '1 hour' - (g % 60 || ' minutes')::interval END,
            CASE WHEN g < $3::int
                 THEN now() - interval '26 hours' - (g % 600 || ' minutes')::interval + interval '999 seconds'
                 ELSE now() - interval '1 hour' - (g % 60 || ' minutes')::interval + interval '8 milliseconds' END
       FROM generate_series(0, $1::int - 1) g`,
    [TOTAL, TASKS, oldShare],
  );
  await s.pool.query('VACUUM ANALYZE tasks, runs');
  s.log(
    `seeded ${TOTAL} runs — ${oldShare} predate the 24h window, ` +
      `${TOTAL - oldShare} created within it`,
  );

  const withIndex = await explain(s, 'WITH runs_created_idx — windowed stats query');
  await s.check('the windowed aggregation reaches runs_created_idx, not a table scan', async () => {
    // The planner may pick a plain or a bitmap index scan depending on the
    // windowed share — either is the point. What must never happen is the
    // plan reaching the whole table.
    s.assert(
      !/Seq Scan on runs/.test(withIndex.text) &&
        /(?:Index Scan using|Bitmap Index Scan on) runs_created_idx/.test(withIndex.text),
      `expected an index scan on runs_created_idx, got:\n${withIndex.text}`,
    );
  });

  await s.pool.query('DROP INDEX runs_created_idx');
  await s.pool.query('ANALYZE runs');
  const without = await explain(s, 'WITHOUT runs_created_idx — same query');

  await s.check('without the index the plan degrades to a full-table scan', async () => {
    s.assert(
      /Seq Scan on runs/.test(without.text),
      `expected a Seq Scan once runs_created_idx is gone, got:\n${without.text}`,
    );
  });

  s.log(
    `windowed scan: ${withIndex.ms} ms / ${withIndex.buffers} buffers   ` +
      `full scan: ${without.ms} ms / ${without.buffers} buffers`,
  );
  await s.check('reads at least 4x fewer buffers than the unindexed plan', async () => {
    s.assert(
      withIndex.buffers * 4 <= without.buffers,
      `expected a large buffer reduction, got ${withIndex.buffers} (indexed) → ` +
        `${without.buffers} (full scan)`,
    );
  });
}

await runScenario(
  {
    name: 'stats-bench',
    what: 'the /tasks stats aggregation scans only the 24h window via runs_created_idx (PF1)',
    db: { name: 'better_trigger_stats_bench', envVar: 'BT_STATS_BENCH_DB' },
  },
  main,
);
