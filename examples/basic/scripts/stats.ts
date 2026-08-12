/* =============================================================================
   @better-trigger/example-basic — task-stats time-window e2e (PF1,
   todos/02-performance.md).

   The unit tests pin the SQL shape of computeTaskStats; they cannot prove the
   numbers are right on a real database. This scenario inserts runs with
   controlled created_at values (inside and 26h outside the 24h window),
   serves them through a real daemon's GET /tasks, and asserts that:

     - a task with both windowed and 26h-old runs reports ONLY the windowed
       ones: runs24h = 4, successRate = 75, and p50/p95 in the tens of ms —
       if the window ever stopped filtering, the 999-second historical runs
       would dominate the percentiles and widen the success denominator;
     - a task whose runs are all 26h old reports zero/null windowed stats but
       keeps its all-history lastRunAt;
     - a task with no runs at all renders zero/null without any per-task
       percentile query (the one-GROUP-BY-aggregation shape).

   Env:
     DATABASE_URL  base connection derived from it; default
                   postgres://localhost:5432/better_trigger
     BT_STATS_DB   override the provisioned database name
     BT_STATS_PORT override the daemon's port (default 4906)
   ============================================================================= */
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { freePort, portFromEnv, runScenario, startDaemon, type Scenario } from '@better-trigger/testing';

const PORT =
  process.env.BT_STATS_PORT !== undefined ? Number(process.env.BT_STATS_PORT) : await freePort();

interface TaskRow {
  id: string;
  runs24h: number;
  p50Ms: number | null;
  p95Ms: number | null;
  successRate: number | null;
  lastRunAt: string | null;
}

async function main(s: Scenario): Promise<void> {
  const { projectId, env } = DEFAULT_NAMESPACE;

  await s.pool.query(
    `INSERT INTO tasks (id, project_id, env, name, trigger_source)
       VALUES ('warm', $1, $2, 'warm', 'api'),
              ('cold', $1, $2, 'cold', 'api'),
              ('idle', $1, $2, 'idle', 'api')`,
    [projectId, env],
  );

  // warm: 4 runs created ~1h ago (3 completed in 8ms, 1 failed) PLUS 4 runs
  // created 26h ago (completed, 999s long). If the 24h window did not filter,
  // the old runs would drag p50/p95 up to ~500s and push successRate to 7/8.
  // cold: only 26h-old completed runs (999s long).
  await s.pool.query(
    `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type,
                       attempt, max_attempts, created_at, started_at, finished_at)
     SELECT 'warm-' || g, $1, $2, 'warm',
            CASE WHEN g < 3 THEN 'completed' ELSE 'failed' END,
            'api', 1, 1,
            now() - interval '1 hour' + (g || ' minutes')::interval,
            now() - interval '1 hour' + (g || ' minutes')::interval,
            now() - interval '1 hour' + (g || ' minutes')::interval + interval '8 milliseconds'
       FROM generate_series(0, 3) g
     UNION ALL
     SELECT 'warm-old-' || g, $1, $2, 'warm', 'completed', 'api', 1, 1,
            now() - interval '26 hours' - (g || ' minutes')::interval,
            now() - interval '26 hours' - (g || ' minutes')::interval,
            now() - interval '26 hours' - (g || ' minutes')::interval + interval '999 seconds'
       FROM generate_series(0, 3) g
     UNION ALL
     SELECT 'cold-' || g, $1, $2, 'cold', 'completed', 'api', 1, 1,
            now() - interval '26 hours' - (g || ' minutes')::interval,
            now() - interval '26 hours' - (g || ' minutes')::interval,
            now() - interval '26 hours' - (g || ' minutes')::interval + interval '999 seconds'
       FROM generate_series(0, 3) g`,
    [projectId, env],
  );
  s.log('seeded warm (4 windowed + 4 old), cold (4 old), idle (none)');

  const daemon = await startDaemon({ databaseUrl: s.db.url, port: PORT, serve: true });
  s.cleanup(() => daemon.kill());

  const res = await fetch(`http://localhost:${PORT}/api/v1/tasks`);
  s.assert(res.ok, `GET /tasks answered ${res.status}`);
  const body = (await res.json()) as { tasks: TaskRow[] };
  const byId = new Map(body.tasks.map((t) => [t.id, t]));

  await s.check('windowed runs only: runs24h / p50 / p95 / successRate', async () => {
    const warm = byId.get('warm');
    s.assert(warm, 'warm task is listed');
    s.assert(warm!.runs24h === 4, `warm runs24h = ${warm!.runs24h}, expected 4`);
    s.assert(
      warm!.p50Ms !== null && warm!.p50Ms < 100,
      `warm p50Ms = ${warm!.p50Ms} — 26h-old 999s runs must not leak in`,
    );
    s.assert(
      warm!.p95Ms !== null && warm!.p95Ms < 100,
      `warm p95Ms = ${warm!.p95Ms} — 26h-old 999s runs must not leak in`,
    );
    s.assert(
      warm!.successRate === 75,
      `warm successRate = ${warm!.successRate}, expected 75 (3/4 windowed, not 7/8)`,
    );
  });

  await s.check('lastRunAt is the most recent run over ALL history', async () => {
    const warm = byId.get('warm');
    s.assert(warm?.lastRunAt != null, 'warm lastRunAt is set');
    s.assert(
      Date.parse(warm!.lastRunAt!) > Date.now() - 2 * 3_600_000,
      `warm lastRunAt should be the 1h-old windowed run, got ${warm!.lastRunAt}`,
    );
    const cold = byId.get('cold');
    s.assert(cold?.lastRunAt != null, 'cold lastRunAt is set (all-history, not windowed)');
    s.assert(
      Date.parse(cold!.lastRunAt!) < Date.now() - 25 * 3_600_000,
      `cold lastRunAt should be the 26h-old run, got ${cold!.lastRunAt}`,
    );
  });

  await s.check('a task with only 26h-old runs reports zero/null windowed stats', async () => {
    const cold = byId.get('cold');
    s.assert(cold, 'cold task is listed');
    s.assert(cold!.runs24h === 0, `cold runs24h = ${cold!.runs24h}, expected 0`);
    s.assert(cold!.p50Ms === null && cold!.p95Ms === null && cold!.successRate === null,
      'cold p50/p95/successRate must be null (no runs in the window)');
  });

  await s.check('a task with no runs renders zero/null (no per-task percentile)', async () => {
    const idle = byId.get('idle');
    s.assert(idle, 'idle task is listed');
    s.assert(idle!.runs24h === 0 && idle!.p50Ms === null && idle!.p95Ms === null &&
      idle!.successRate === null && idle!.lastRunAt === null,
      'idle stats must all be zero/null');
  });
}

await runScenario(
  {
    name: 'stats',
    what: 'task stats aggregate only the 24h window; lastRunAt stays all-history (PF1)',
    db: { name: 'better_trigger_stats', envVar: 'BT_STATS_DB' },
  },
  main,
);
