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
     - CANDIDATE_NS_SQL / CANDIDATE_SQL: queue.ts claimRuns (the unpinned
       branch). claimRuns scans once PER NAMESPACE (p1-08), each scan a pair
       of constant equalities (nsPredicateFor('q', ns, params)) — CANDIDATE_NS_SQL
       is that per-namespace scan verbatim, the query that must bind
       queue_claimable_idx even when the worker serves ≥2 namespaces.
       CANDIDATE_SQL is the same single-namespace scan, also verbatim in
       examples/basic/scripts/claim-scan-bench.ts.
     - STEP_SQL / LOGS_SQL: runs.ts snapshotRun (run detail page).
      - TIMER_WAITS_SQL / ORPHAN_WAITS_SQL: orchestrator.ts scanWaits phase 1
        (the due-wait sweep, split into a timer scan and an orphan scan).
     - RUNS_SQL: runs.ts getRunRow / lockRunRow (runs PK detail).

   Plans are only pinned where they are CORRECT today. The p1-06 waits-index
   gap landed its fix (migration 0012 + the namespace-scoped child-wake probe
   in runs.ts) and its plan tests land with it: WAKE_SQL pins waits_child_run_idx,
   CANCEL_SELECT_SQL pins waits_run_idx.

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

/** The unpinned claim candidate SELECT — queue.ts claimRuns, verbatim. This is
 *  the single-namespace scan a claim call issues (p1-08: one scan per
 *  namespace, each a pair of constant equalities — the q-side binds
 *  queue_claimable_idx's leading (project_id, env) columns directly, the r-side
 *  repeats the equality so the semantics are explicit). */
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
      AND q.project_id = $3::text AND q.env = $4::text
      AND r.project_id = $3::text AND r.env = $4::text
      AND r.task_id = ANY($1::text[])
    ORDER BY q.priority DESC, q.id ASC
    LIMIT $2
    FOR UPDATE OF q SKIP LOCKED`;

/** The per-namespace claim scan — queue.ts claimRuns (the unpinned branch),
 *  verbatim. p1-08 splits the claim loop into one scan PER NAMESPACE: the
 *  q-side predicate is nsPredicateFor('q', ns, params), numbered from $3
 *  (after $1 task ids, $2 window); the r-side repeats the same $3/$4 pair.
 *  Constant equalities on both sides bind queue_claimable_idx's leading
 *  (project_id, env) columns directly even with ≥2 namespaces — the pre-p1-08
 *  VALUES semi-join over every namespace at once is what abandoned the index.
 *  Params: [taskIds, window, projectId, env]. */
const CANDIDATE_NS_SQL = `SELECT q.id AS queue_id, q.run_id,
      r.task_id, r.payload, r.attempt, r.max_attempts,
      r.code_version, r.project_id, r.env, r.concurrency_key,
      t.concurrency_limit
   FROM queue q
   JOIN runs r ON r.id = q.run_id
              AND r.project_id = q.project_id AND r.env = q.env
   LEFT JOIN tasks t ON t.id = r.task_id
              AND t.project_id = r.project_id AND t.env = r.env
  WHERE q.available_at <= now() AND q.locked_by IS NULL
    AND q.project_id = $3::text AND q.env = $4::text
    AND r.project_id = $3::text AND r.env = $4::text
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

/** The due timer-wait scan — orchestrator.ts scanWaits phase 1, verbatim
 *  (the per-namespace form via nsPredicateFor — p1-08). */
const TIMER_WAITS_SQL = `SELECT id, run_id, project_id, env, step_seq, fingerprint, kind, child_run_id
     FROM waits
    WHERE status = 'pending'
      AND kind IN ('duration','until')
      AND resume_at <= now()
      AND waits.project_id = $1::text AND waits.env = $2::text
    ORDER BY resume_at ASC
    LIMIT 50`;

/** The orphan run-wait scan — orchestrator.ts scanWaits phase 1, verbatim
 *  (the per-namespace form via nsPredicateFor — p1-08). */
const ORPHAN_WAITS_SQL = `SELECT id, run_id, project_id, env, step_seq, fingerprint, kind, child_run_id
     FROM waits
    WHERE status = 'pending'
      AND kind = 'run'
      AND child_run_id IS NULL
      AND waits.project_id = $1::text AND waits.env = $2::text
    ORDER BY id ASC
    LIMIT 10`;

/** The runs-row read — runs.ts getRunRow / lockRunRow, verbatim. */
const RUNS_SQL = `SELECT id, task_id, status, attempt, max_attempts,
            recoveries, max_recoveries, parent_run_id,
            payload, project_id, env, concurrency_key, priority, code_version, fencing_token
     FROM runs WHERE id = $1 AND project_id = $2 AND env = $3`;

/** The child-completion parent-wake probe — runs.ts wakeParentIfWaiting,
 *  verbatim. child_run_id + the child's namespace (default, prod) bind the
 *  leading columns of waits_child_run_idx. */
const WAKE_SQL = `SELECT id, run_id, project_id, env, step_seq, fingerprint FROM waits
      WHERE child_run_id = $1 AND kind = 'run' AND status = 'pending'
        AND project_id = $2 AND env = $3`;

/** The cancel-cleanup scan — runs.ts cancelRun's `UPDATE waits SET
 *  status='canceled' WHERE run_id=$1 AND status='pending' AND project_id=$2
 *  AND env=$3`, in SELECT form (EXPLAIN on the UPDATE would execute it). */
const CANCEL_SELECT_SQL = `SELECT id FROM waits
     WHERE run_id = $1 AND status = 'pending' AND project_id = $2 AND env = $3`;

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

/** Seed one namespace's claim backlog: `total` runs + queue rows across
 *  `tasks` task ids, `claimable` of them unlocked. The queue rows are
 *  md5-scattered so the claimable subset is not one contiguous block a
 *  sequential scan would find immediately (mirrors the claim-scan bench).
 *  `runPrefix` disambiguates run ids across namespaces (queue.run_id is
 *  globally unique); rows land in `projectId`/prod. */
async function seedClaimBacklog(
  pool: Parameters<typeof assertIndexScan>[0],
  total: number,
  tasks: number,
  claimable: number,
  projectId: string,
  runPrefix: string,
) {
  await pool.query(
    `INSERT INTO runs (id, task_id, status, payload, trigger_type, attempt, max_attempts, priority, project_id, env)
       SELECT $3::text || g,
              'task-' || (g % $2::int),
              CASE WHEN g < $4::int THEN 'queued' ELSE 'running' END,
              jsonb_build_object('n', g),
              'api', 1, 3,
              CASE WHEN g % 10 = 0 THEN 1 + (g % 5) ELSE 0 END,
              $5, 'prod'
         FROM generate_series(0, $1::int - 1) g`,
    [total, tasks, runPrefix, Math.floor(total / 2), projectId],
  );
  await pool.query(
    `INSERT INTO queue (run_id, available_at, priority, locked_by, locked_at, lease_until, project_id, env)
       SELECT $3::text || g,
              now() - interval '1 minute',
              CASE WHEN g % 10 = 0 THEN 1 + (g % 5) ELSE 0 END,
              CASE WHEN g < $4::int THEN NULL ELSE 'worker-' || (g % $2::int) END,
              CASE WHEN g < $4::int THEN NULL ELSE now() - interval '30 seconds' END,
              CASE WHEN g < $4::int THEN NULL ELSE now() + interval '30 seconds' END,
              $5, 'prod'
         FROM generate_series(0, $1::int - 1) g
        ORDER BY md5(g::text)`,
    [total, tasks, runPrefix, claimable, projectId],
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

/** Seed `n` waits md5-scattered across run ids, child_run_id values, kinds and
 *  statuses, with exactly ONE row in the default namespace that is both the
 *  child-wake match (child_run_id `match`, kind 'run', status 'pending') and
 *  the cancel-cleanup match (run_id 'run-0', status 'pending'). The predicate
 *  rows share the scattered position their g-value lands in, so neither probe
 *  is served by a contiguous block a seq scan would find immediately. */
async function seedScatteredWaits(
  pool: Parameters<typeof assertIndexScan>[0],
  n: number,
  runs: number,
  matchG: number,
) {
  await pool.query(
    `INSERT INTO waits (run_id, step_seq, kind, resume_at, status, project_id, env, child_run_id)
       SELECT CASE WHEN g = $3::int THEN 'run-0' ELSE 'run-' || (g % $2::int) END, g % 100,
              CASE WHEN g = $3::int THEN 'run'
                   WHEN g % 7 = 0 THEN 'run'
                   WHEN g % 2 = 0 THEN 'duration'
                   ELSE 'until' END,
              CASE WHEN g % 7 = 0 THEN NULL ELSE now() - interval '1 minute' END,
              CASE WHEN g = $3::int THEN 'pending'
                   WHEN g % 5 = 0 THEN 'completed'
                   WHEN g % 5 = 1 THEN 'canceled'
                   ELSE 'pending' END,
              'default', 'prod',
              CASE WHEN g = $3::int THEN 'run-0'
                   WHEN g % 7 = 0 THEN 'run-' || (g % $2::int)
                   ELSE NULL END
         FROM generate_series(0, $1::int - 1) g
        ORDER BY md5(g::text)`,
    [n, runs, matchG],
  );
  await pool.query('VACUUM ANALYZE waits');
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
      await seedClaimBacklog(pool, TOTAL, TASKS, CLAIMABLE, 'default', 'run-');
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

  it('claim candidate scan per namespace is an Index Scan on queue_claimable_idx even with 2 namespaces', async () => {
    await withPg('plans_claim_ns', async ({ pool }) => {
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
      // Two namespaces live side by side: the default backlog plus a second
      // (acme) one. queue.run_id is globally unique, so the second namespace's
      // runs get their own run-id prefix. claimRuns issues CANDIDATE_NS_SQL
      // once per namespace — a worker serving ≥2 namespaces must still bind
      // queue_claimable_idx per scan (p1-08; the VALUES semi-join the old
      // single multi-namespace query used abandoned the index).
      await seedClaimBacklog(pool, TOTAL, TASKS, CLAIMABLE, 'default', 'run-');
      await seedClaimBacklog(pool, TOTAL, TASKS, CLAIMABLE, 'acme', 'run-acme-');
      await pool.query('VACUUM ANALYZE tasks, runs, queue');

      const taskIds = Array.from({ length: TASKS }, (_, i) => `task-${i}`);
      for (const ns of [['default', 'prod'], ['acme', 'prod']] as const) {
        const plan = await assertIndexScan(
          pool,
          CANDIDATE_NS_SQL,
          [taskIds, CLAIM_WINDOW, ...ns],
          'queue',
        );
        expect(planNodeTypes(JSON.parse(plan))).not.toContain('Sort');
      }
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

  it('child-wake probe is an Index Scan on waits_child_run_idx', async () => {
    await withPg('plans_wake', async ({ pool }) => {
      const RUNS = 20000;
      await seedRuns(pool, RUNS, 1);
      // 40k waits scattered across run ids / child_run_id values / kinds /
      // statuses; exactly ONE is the child-wake match (child_run_id 'run-0',
      // kind 'run', status 'pending') in the default namespace.
      await seedScatteredWaits(pool, 40000, RUNS, 12345);

      const plan = await assertIndexScan(pool, WAKE_SQL, ['run-0', ...NS], 'waits');
      expect(planNodeTypes(JSON.parse(plan))).not.toContain('Seq Scan');
    });
  });

  it('cancelRun waits cleanup is an Index Scan on waits_run_idx', async () => {
    await withPg('plans_cancel', async ({ pool }) => {
      const RUNS = 20000;
      await seedRuns(pool, RUNS, 1);
      // The cancel-cleanup match (run_id 'run-0', status 'pending') is the
      // same scattered row — run_id 'run-0' otherwise only ever carries
      // completed/canceled rows here.
      await seedScatteredWaits(pool, 40000, RUNS, 12345);

      const plan = await assertIndexScan(pool, CANCEL_SELECT_SQL, ['run-0', ...NS], 'waits');
      expect(planNodeTypes(JSON.parse(plan))).not.toContain('Seq Scan');
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
