import { describe, expect, it } from 'vitest';
import { assertIndexScan, describePg, planNodeTypes, withPg } from './helpers';

/* =============================================================================
   @better-trigger/kernel — index-plan pins (todos/p1-22).

   The hot queries' PLANS, not their SQL text: a regression that makes the
   planner abandon the index the query was built around (an index dropped,
   an ORDER BY that stops matching the index key order, a predicate change
   that defeats a partial index) fails loudly here instead of hiding behind
   a string comparison against a fake client.

   Each query below is a VERBATIM copy of the one the kernel actually runs —
   a bench that measures a query nobody runs proves nothing:
     - CANDIDATE_SQL: queue.ts claimRuns (the unpinned branch), also verbatim
       in examples/basic/scripts/claim-scan-bench.ts.
     - STEP_SQL / LOGS_SQL: runs.ts snapshotRun (run detail page).
      - TIMER_WAITS_SQL / ORPHAN_WAITS_SQL: orchestrator.ts scanWaits phase 1
        (the due-wait sweep, split into a timer scan and an orphan scan).
     - RUNS_SQL: runs.ts getRunRow / lockRunRow (runs PK detail).

   Plans are only pinned where they are CORRECT today. The waits run_id wake
   query (waits_child_run_idx) is deliberately absent: that index gap is the
   p1-06 regression and its plan test lands with the fix.

   Seeding sizes are tuned so the planner's cost model picks the index on
   default cost parameters — small tables seq-scan (a 200-row claim backlog
   sorts; a 100-row runs table scans), so each case seeds enough rows that the
   chosen plan is the one the hot path lives in, then ANALYZEs so the planner
   works from real statistics.
   ============================================================================= */

/** Candidate window of a `limit: 10` slot poll — claimWindow(10) in queue.ts. */
const CLAIM_WINDOW = 20;
const LIMIT = 100;

/** Default namespace the seed rows live in (table defaults). */
const NS = ['default', 'prod'];

/** The unpinned claim candidate SELECT — queue.ts claimRuns, verbatim. */
const CANDIDATE_SQL = `SELECT q.id AS queue_id, q.run_id,
          r.task_id, r.payload, r.attempt, r.max_attempts,
          r.code_version, r.project_id, r.env, r.concurrency_key,
          t.concurrency_limit
     FROM queue q
     JOIN runs r ON r.id = q.run_id
                AND r.project_id = q.project_id AND r.env = q.env
     LEFT JOIN tasks t ON t.id = r.task_id
                AND t.project_id = r.project_id AND t.env = r.env
    WHERE q.available_at <= now() AND q.locked_by IS NULL
      AND (r.project_id, r.env) IN (VALUES ($3::text, $4::text))
      AND r.task_id = ANY($1::text[])
    ORDER BY q.priority DESC, q.id ASC
    LIMIT $2
    FOR UPDATE OF q SKIP LOCKED`;

/** The claim-time step snapshot — queue.ts claimRuns, verbatim. */
const STEP_SQL = `SELECT seq, kind, label, status, output, error, fingerprint
       FROM run_steps WHERE run_id = $1 AND project_id = $2 AND env = $3
       ORDER BY seq ASC`;

/** The run-detail newest-log page — runs.ts snapshotRun, verbatim. */
const LOGS_SQL = `SELECT id, step_seq, level, message, data, ts
     FROM logs WHERE run_id = $1 AND project_id = $2 AND env = $3
    ORDER BY id DESC LIMIT $4`;

/** The due timer-wait scan — orchestrator.ts scanWaits phase 1, verbatim. */
const TIMER_WAITS_SQL = `SELECT id, run_id, project_id, env, step_seq, fingerprint, kind, child_run_id
     FROM waits
    WHERE status = 'pending'
      AND kind IN ('duration','until')
      AND resume_at <= now()
      AND (waits.project_id, waits.env) IN (VALUES ($1::text, $2::text))
    ORDER BY resume_at ASC
    LIMIT 50`;

/** The orphan run-wait scan — orchestrator.ts scanWaits phase 1, verbatim. */
const ORPHAN_WAITS_SQL = `SELECT id, run_id, project_id, env, step_seq, fingerprint, kind, child_run_id
     FROM waits
    WHERE status = 'pending'
      AND kind = 'run'
      AND child_run_id IS NULL
      AND (waits.project_id, waits.env) IN (VALUES ($1::text, $2::text))
    ORDER BY id ASC
    LIMIT 10`;

/** The runs-row read — runs.ts getRunRow / lockRunRow, verbatim. */
const RUNS_SQL = `SELECT id, task_id, status, attempt, max_attempts,
            recoveries, max_recoveries, parent_run_id,
            payload, project_id, env, concurrency_key, priority, code_version, fencing_token
     FROM runs WHERE id = $1 AND project_id = $2 AND env = $3`;

/** Seed `n` runs across `tasks` task ids (task rows may be absent — the claim
 *  query LEFT JOINs them; the other cases' FKs only need the runs row). */
async function seedRuns(pool: Parameters<typeof assertIndexScan>[0], n: number, tasks: number) {
  await pool.query(
    `INSERT INTO runs (id, task_id, status, payload, trigger_type, attempt, max_attempts, priority)
       SELECT 'run-' || g,
              'task-' || (g % $2::int),
              CASE WHEN g < $3::int THEN 'queued' ELSE 'running' END,
              jsonb_build_object('n', g),
              'api', 1, 3,
              CASE WHEN g % 10 = 0 THEN 1 + (g % 5) ELSE 0 END
         FROM generate_series(0, $1::int - 1) g`,
    [n, tasks, Math.floor(n / 2)],
  );
}

/** Seed a mixed waits backlog: due timer waits (kind duration/until, resume_at
 *  in the past) + orphan run-waits (kind run, child_run_id NULL — the C5
 *  branch), with some resolved rows the 'pending' predicate must skip. */
async function seedWaits(pool: Parameters<typeof assertIndexScan>[0], n: number, runs: number) {
  await pool.query(
    `INSERT INTO waits (run_id, step_seq, kind, resume_at, status, project_id, env)
       SELECT 'run-' || (g % $2::int), g % 100,
              CASE WHEN g % 10 = 0 THEN 'run' ELSE 'duration' END,
              CASE WHEN g % 10 = 0 THEN NULL ELSE now() - interval '1 minute' END,
              CASE WHEN g % 4 = 0 THEN 'completed' ELSE 'pending' END,
              'default', 'prod'
         FROM generate_series(0, $1::int - 1) g`,
    [n, runs],
  );
}

describePg('index plans', () => {
  it('claim candidate scan reaches queue through queue_claimable_idx with no Sort', async () => {
    await withPg('plans_claim', async ({ pool }) => {
      const TASKS = 8;
      const TOTAL = 5000;
      // 10% unclaimed — a busy backlog is mostly rows some worker holds, and
      // those are exactly the rows the partial index must let the scan skip.
      const CLAIMABLE = 500;
      await pool.query(
        `INSERT INTO tasks (id, name, trigger_source)
           SELECT 'task-' || g, 'task ' || g, 'api' FROM generate_series(0, $1::int) g`,
        [TASKS - 1],
      );
      await seedRuns(pool, TOTAL, TASKS);
      // md5-scattered so the claimable subset is not one contiguous block a
      // sequential scan would find immediately (mirrors the claim-scan bench).
      await pool.query(
        `INSERT INTO queue (run_id, available_at, priority, locked_by, locked_at, lease_until)
           SELECT 'run-' || g,
                  now() - interval '1 minute',
                  CASE WHEN g % 10 = 0 THEN 1 + (g % 5) ELSE 0 END,
                  CASE WHEN g < $3::int THEN NULL ELSE 'worker-' || (g % $2::int) END,
                  CASE WHEN g < $3::int THEN NULL ELSE now() - interval '30 seconds' END,
                  CASE WHEN g < $3::int THEN NULL ELSE now() + interval '30 seconds' END
             FROM generate_series(0, $1::int - 1) g
            ORDER BY md5(g::text)`,
        [TOTAL, TASKS, CLAIMABLE],
      );
      await pool.query('VACUUM ANALYZE tasks, runs, queue');

      const taskIds = Array.from({ length: TASKS }, (_, i) => `task-${i}`);
      const plan = await assertIndexScan(
        pool,
        CANDIDATE_SQL,
        [taskIds, CLAIM_WINDOW, ...NS],
        'queue',
      );
      // The index key order IS the ORDER BY (priority DESC, id ASC), so the
      // scan stops at the LIMIT; a Sort here means the LIMIT no longer bounds
      // the work and every claimable row gets ordered on every poll.
      expect(planNodeTypes(JSON.parse(plan))).not.toContain('Sort');
    });
  });

  it('claim-time run_steps snapshot by run_id is an Index Scan on the PK', async () => {
    await withPg('plans_steps', async ({ pool }) => {
      const RUNS = 6000;
      await seedRuns(pool, RUNS, 1);
      // One step per run: the planner's cost model turns a multi-row by-run_id
      // fetch into a Bitmap Heap Scan + Sort (a legitimate use of the same
      // PK), so the seed keeps each run's timeline at a single row to pin the
      // plain Index Scan that serves the hot snapshot path.
      await pool.query(
        `INSERT INTO run_steps (run_id, seq, project_id, env, kind, status, attempt)
           SELECT 'run-' || (g % $1::int), 1, 'default', 'prod', 'step', 'completed', 1
             FROM generate_series(0, $1::int - 1) g`,
        [RUNS],
      );
      await pool.query('ANALYZE runs, run_steps');

      await assertIndexScan(pool, STEP_SQL, ['run-0', ...NS], 'run_steps');
    });
  });

  it('run-detail log page by run_id is an Index Scan on logs_run_id_idx', async () => {
    await withPg('plans_logs', async ({ pool }) => {
      const RUNS = 8000;
      await seedRuns(pool, RUNS, 1);
      // Logs spread across every run (so scanning the table is expensive) plus
      // a dense timeline for the queried run.
      await pool.query(
        `INSERT INTO logs (run_id, step_seq, project_id, env, level, message)
           SELECT 'run-' || (g % $2::int), g % 100, 'default', 'prod', 'info', 'log ' || g
             FROM generate_series(0, $1::int - 1) g`,
        [40000, RUNS],
      );
      await pool.query(
        `INSERT INTO logs (run_id, step_seq, project_id, env, level, message)
           SELECT $1, g, 'default', 'prod', 'info', 'log ' || g
             FROM generate_series(1, $2::int) g`,
        ['run-0', 200],
      );
      await pool.query('ANALYZE runs, logs');

      await assertIndexScan(pool, LOGS_SQL, ['run-0', ...NS, LIMIT], 'logs');
    });
  });

  it('timer wait-due sweep is an Index Scan on waits_status_resume_idx', async () => {
    await withPg('plans_waits_timer', async ({ pool }) => {
      const RUNS = 8000;
      await seedRuns(pool, RUNS, 1);
      await seedWaits(pool, 20000, RUNS);
      await pool.query('ANALYZE runs, waits');

      await assertIndexScan(pool, TIMER_WAITS_SQL, [...NS], 'waits');
    });
  });

  it('orphan run-wait sweep is an Index Scan on the waits PK', async () => {
    await withPg('plans_waits_orphan', async ({ pool }) => {
      const RUNS = 8000;
      await seedRuns(pool, RUNS, 1);
      await seedWaits(pool, 20000, RUNS);
      await pool.query('ANALYZE runs, waits');

      await assertIndexScan(pool, ORPHAN_WAITS_SQL, [...NS], 'waits');
    });
  });

  it('run detail by id is an Index Scan on the runs PK', async () => {
    await withPg('plans_runs', async ({ pool }) => {
      const RUNS = 2000;
      await seedRuns(pool, RUNS, 1);
      await pool.query('ANALYZE runs');

      await assertIndexScan(pool, RUNS_SQL, ['run-0', ...NS], 'runs');
    });
  });
});
