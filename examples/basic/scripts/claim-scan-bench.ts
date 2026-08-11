/* =============================================================================
   @better-trigger/example-basic — claim-scan index bench (todos/02 PF2).

   The claim path's candidate SELECT is the hottest query in the system: every
   execution slot runs it on every poll. PF2 is a claim about its PLAN, and a
   plan claim can only be settled by a planner — so this harness builds a
   representative backlog and reads `EXPLAIN (ANALYZE, BUFFERS)` twice against
   it: once with `queue_claimable_idx` dropped (the shape shipped before 0006)
   and once with it back.

   Representative means: 50k queue rows of which only 10% are claimable, because
   a busy queue is mostly rows some worker already holds — those are exactly the
   rows the pre-0006 plan had to read and throw away. A tenth of the claimable
   ones are future-dated (delayed / backed-off runs), which is the part of the
   predicate that CANNOT be indexed: `now()` is not immutable, so
   `available_at <= now()` stays a filter no matter what the index looks like.

   Checks, not just numbers — the point is to fail if the index stops being the
   plan the kernel needs:
     - the candidate scan reaches `queue` through queue_claimable_idx;
     - there is no Sort node (the index key order IS `priority DESC, id ASC`,
       so the LIMIT stops the scan instead of ordering every claimable row);
     - it touches dramatically fewer buffers than the same query without it.

   Phase 2 (PF5, todos/02-performance.md) adds the delayed-rows question: does a
   large backlog of future-dated (`available_at > now()`) unclaimed rows make
   the claim scan sweep them on every poll? `available_at <= now()` can never be
   an index predicate (now() is not immutable), so delayed rows are skipped by
   a filter; the check is that the scan reads a BOUNDED number of them to fill
   its window — not the whole delayed backlog. The seeding interleaves 27k
   delayed rows with 3k due ones (md5-scattered, same priority), so the index
   really does hit the delayed rows before the due ones.

   Runs on @better-trigger/testing: runScenario provisions + migrates the
   scenario's database and folds the verdict into the exit code. A live Postgres
   is required, so this is NOT part of `bun run test`, and it is not in
   scripts/acceptance.ts either — it is a bench, run it by hand after touching
   the claim query or the queue indexes:  bun run bench:claim-scan

   Env:
     DATABASE_URL       base connection derived from it; default
                        postgres://localhost:5432/better_trigger
     BT_CLAIM_SCAN_DB   override the provisioned database name
   ============================================================================= */
import { runScenario, type Scenario } from '@better-trigger/testing';

/** Queue rows to seed — a backlog big enough that a sequential scan shows. */
const TOTAL = 50_000;
/** Of those, the unclaimed subset (`locked_by IS NULL`). The other 90% are held. */
const CLAIMABLE = 5_000;
/** Of the claimable, the ones whose `available_at` is still in the future. */
const FUTURE = 500;
/** Distinct tasks; the worker in this bench is registered for all of them. */
const TASKS = 8;
/** Candidate window of a `limit: 1` slot poll — claimWindow(1) in queue.ts. */
const WINDOW = 10;

/* Phase 2 (PF5): a backlog whose UNCLAIMED rows are 90% future-dated — the
   delayed / backed-off runs that accumulate in a busy system. The held rows
   are invisible to the partial index (locked_by IS NULL), so this is the worst
   realistic shape of the index contents. */
const D2_TOTAL = 60_000;
/** Held by a worker — not even in queue_claimable_idx. */
const D2_HELD = 30_000;
/** Of the unclaimed rows, the ones still in the future (delayed). */
const D2_DELAYED = 27_000;
/** Due + unclaimed — the only rows the scan can return. */
const D2_DUE = D2_TOTAL - D2_HELD - D2_DELAYED;

/**
 * VERBATIM copy of the unpinned claim candidate SELECT in
 * packages/kernel/src/queue.ts (claimRuns), including the namespace predicate
 * in its VALUES form (namespacePredicate('r', ...) — the leading-column
 * equality constraint is what lets queue_claimable_idx satisfy the ORDER BY)
 * and the join conditions on (project_id, env). If the kernel query changes
 * shape, change it here too — a bench measuring a query nobody runs proves
 * nothing, and this one fails loudly on a 60k backlog if the predicate ever
 * drops out of the kernel query.
 */
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

/** The seeded rows live in the default namespace (table defaults). */
const NS_PARAMS = ['default', 'prod'];

const taskIds = Array.from({ length: TASKS }, (_, i) => `task-${i}`);

interface Plan {
  /** The plan as EXPLAIN printed it, joined back into one block. */
  text: string;
  /** `Buffers: shared hit=N` on the top node — the whole query's page reads. */
  buffers: number;
  /** Top-node `Execution Time`, in ms. */
  ms: number;
  /** `Rows Removed by Filter` — entries the scan read and threw away (the
   *  future-dated rows, in the delayed-heavy phase). */
  removed: number;
}

async function main(s: Scenario): Promise<void> {
  const pool = s.pool;
  // Nothing here is a post-mortem candidate: the data is synthetic and huge.
  s.cleanup(() => s.db.drop());

  /* -------------------------------------------------------------------------
   * Seed. One run per queue row; the queue rows are inserted in md5 order so
   * the claimable subset is scattered through the id space rather than sitting
   * in one contiguous block a sequential scan would find immediately.
   * ----------------------------------------------------------------------- */
  await pool.query(
    `INSERT INTO tasks (id, name, trigger_source)
       SELECT 'task-' || g, 'task ' || g, 'api' FROM generate_series(0, $1::int) g`,
    [TASKS - 1],
  );
  await pool.query(
    `INSERT INTO runs (id, task_id, status, payload, trigger_type, attempt, max_attempts, priority)
       SELECT 'run-' || g,
              'task-' || (g % $2::int),
              CASE WHEN g < $3::int THEN 'queued' ELSE 'running' END,
              jsonb_build_object('n', g),
              'api', 1, 3,
              CASE WHEN g % 10 = 0 THEN 1 + (g % 5) ELSE 0 END
         FROM generate_series(0, $1::int - 1) g`,
    [TOTAL, TASKS, CLAIMABLE],
  );
  await pool.query(
    `INSERT INTO queue (run_id, available_at, priority, locked_by, locked_at, lease_until)
       SELECT 'run-' || g,
              CASE WHEN g < $4::int THEN now() + interval '1 hour'
                   ELSE now() - interval '1 minute' END,
              CASE WHEN g % 10 = 0 THEN 1 + (g % 5) ELSE 0 END,
              CASE WHEN g < $3::int THEN NULL ELSE 'worker-' || (g % $2::int) END,
              CASE WHEN g < $3::int THEN NULL ELSE now() - interval '30 seconds' END,
              CASE WHEN g < $3::int THEN NULL ELSE now() + interval '30 seconds' END
         FROM generate_series(0, $1::int - 1) g
        ORDER BY md5(g::text)`,
    [TOTAL, TASKS, CLAIMABLE, FUTURE],
  );
  // Statistics, not cleanup: without ANALYZE the planner costs this table from
  // defaults and the comparison below measures nothing but a stale estimate.
  await pool.query('VACUUM ANALYZE tasks, runs, queue');
  s.log(
    `seeded ${TOTAL} queue rows — ${CLAIMABLE} claimable (${FUTURE} future-dated), ` +
      `${TOTAL - CLAIMABLE} already held by a worker`,
  );

  /* -------------------------------------------------------------------------
   * EXPLAIN the candidate scan. `FOR UPDATE` really locks, so each run happens
   * in its own transaction that is rolled back; the query is run a few times
   * first because the plan of interest is the warm one the claim loop actually
   * lives in, not a cold-cache outlier.
   * ----------------------------------------------------------------------- */
  async function explain(label: string): Promise<Plan> {
    const client = await pool.connect();
    try {
      for (let i = 0; i < 3; i++) {
        await client.query('BEGIN');
        await client.query(CANDIDATE_SQL, [taskIds, WINDOW, ...NS_PARAMS]);
        await client.query('ROLLBACK');
      }
      await client.query('BEGIN');
      const res = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${CANDIDATE_SQL}`,
         [taskIds, WINDOW, ...NS_PARAMS],
      );
      await client.query('ROLLBACK');
      const text = res.rows.map((r) => r['QUERY PLAN']).join('\n');
      console.log(`\n----- ${label} -----\n${text}\n`);
      return {
        text,
        buffers: Number(text.match(/Buffers: shared hit=(\d+)/)?.[1] ?? 0),
        ms: Number(text.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? 0),
        // The deepest node (the index scan) carries the available_at filter;
        // take the max so a nested plan cannot hide it.
        removed: Math.max(
          0,
          ...[...text.matchAll(/Rows Removed by Filter: (\d+)/g)].map((m) => Number(m[1])),
        ),
      };
    } finally {
      client.release();
    }
  }

  // Rebuilt from what the migration actually created, never from a copy of the
  // CREATE INDEX: this bench has to measure the index that ships, and reading it
  // back also fails loudly here if 0006 was never applied.
  const def = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'queue' AND indexname = 'queue_claimable_idx'`,
  );
  const indexDef = def.rows[0]?.indexdef;
  s.assert(indexDef, 'queue_claimable_idx is missing — did the migrations apply?');

  await pool.query('DROP INDEX queue_claimable_idx');
  await pool.query('ANALYZE queue');
  const before = await explain('BEFORE — without queue_claimable_idx');

  await pool.query(indexDef);
  await pool.query('ANALYZE queue');
  const after = await explain('AFTER — with queue_claimable_idx');

  s.log(
    `before: ${before.ms} ms / ${before.buffers} buffers   ` +
      `after: ${after.ms} ms / ${after.buffers} buffers`,
  );

  await s.check('candidate scan reaches queue through queue_claimable_idx', async () => {
    s.assert(
      /Index Scan using queue_claimable_idx on queue/.test(after.text),
      `expected an index scan on queue_claimable_idx, got:\n${after.text}`,
    );
  });

  await s.check('no Sort node — the index key order is the ORDER BY', async () => {
    // A Sort here would mean the LIMIT no longer stops the scan early: every
    // claimable row would be read and ordered on each poll. That is what a
    // `DESC NULLS LAST` index (drizzle's default for .desc()) produces, since
    // `ORDER BY priority DESC` is NULLS FIRST — hence .nullsFirst() in
    // packages/db/src/schema.ts.
    s.assert(!/->  Sort/.test(after.text), `unexpected Sort node:\n${after.text}`);
  });

  await s.check('reads at least 4x fewer buffers than the unindexed plan', async () => {
    s.assert(
      after.buffers * 4 <= before.buffers,
      `expected a large buffer reduction, got ${before.buffers} → ${after.buffers}`,
    );
  });

  /* -------------------------------------------------------------------------
   * Phase 2 (PF5): a delayed-heavy backlog must not turn the candidate scan
   * into a sweep. Fresh dataset: 60k rows, all at priority 0 (the delay/
   * backoff default), md5-scattered so the 27k future-dated unclaimed rows
   * interleave with the 3k due ones INSIDE the index — the scan really has to
   * skip delayed rows to fill its window.
   * ----------------------------------------------------------------------- */
  await pool.query('DELETE FROM runs'); // queue cascades
  await pool.query(
    `INSERT INTO runs (id, task_id, status, payload, trigger_type, attempt, max_attempts, priority)
       SELECT 'dly-' || g,
              'task-' || (g % $2::int),
              CASE WHEN g < $3::int THEN 'queued' ELSE 'running' END,
              jsonb_build_object('n', g),
              'api', 1, 3, 0
         FROM generate_series(0, $1::int - 1) g`,
    [D2_TOTAL, TASKS, D2_TOTAL - D2_HELD],
  );
  await pool.query(
    `INSERT INTO queue (run_id, available_at, priority, locked_by, locked_at, lease_until)
       SELECT 'dly-' || g,
              CASE WHEN g < $4::int THEN now() + interval '1 hour'
                   ELSE now() - interval '1 minute' END,
              0,
              CASE WHEN g < $3::int THEN NULL ELSE 'worker-' || (g % $2::int) END,
              CASE WHEN g < $3::int THEN NULL ELSE now() - interval '30 seconds' END,
              CASE WHEN g < $3::int THEN NULL ELSE now() + interval '30 seconds' END
         FROM generate_series(0, $1::int - 1) g
        ORDER BY md5(g::text)`,
    [D2_TOTAL, TASKS, D2_TOTAL - D2_HELD, D2_DELAYED],
  );
  await pool.query('VACUUM ANALYZE runs, queue');
  s.log(
    `phase 2: ${D2_TOTAL} rows — ${D2_HELD} held, ` +
      `${D2_DELAYED} delayed (future), ${D2_DUE} due — all priority 0`,
  );

  const delayed = await explain('DELAYED-HEAVY — 27k future rows among the unclaimed');

  await s.check('delayed-heavy claim still reaches queue_claimable_idx without a Sort', async () => {
    s.assert(
      /Index Scan using queue_claimable_idx on queue/.test(delayed.text),
      `expected an index scan on queue_claimable_idx, got:\n${delayed.text}`,
    );
    s.assert(!/->  Sort/.test(delayed.text), `unexpected Sort node:\n${delayed.text}`);
  });

  // Baseline for the same rows with the delay removed: flip the 27k future
  // rows to past-dated and re-EXPLAIN. The datasets are then identical except
  // for the delay, so the buffer delta is exactly the cost of skipping the
  // delayed rows — the claim that "many delayed rows do not worsen claim
  // latency" (PF5 acceptance 3).
  await pool.query(
    `UPDATE queue SET available_at = now() - interval '1 minute' WHERE available_at > now()`,
  );
  await pool.query('VACUUM ANALYZE queue');
  const baseline = await explain('BASELINE — the same rows, all due');

  await s.check('the same rows without the delay keep the same plan', async () => {
    s.assert(
      /Index Scan using queue_claimable_idx on queue/.test(baseline.text),
      `expected an index scan on queue_claimable_idx, got:\n${baseline.text}`,
    );
    s.assert(!/->  Sort/.test(baseline.text), `unexpected Sort node:\n${baseline.text}`);
  });

  await s.check('the scan skips only a bounded slice of the delayed rows', async () => {
    // To fill a window of 10 the scan must read ~10 × (1 + delayed/due) ≈ 100
    // index entries — the assertion says it never sweeps the 27k delayed
    // backlog to get there (5% of it would already be a 25x regression).
    const bound = Math.floor(D2_DELAYED * 0.05);
    s.assert(
      delayed.removed < bound,
      `expected fewer than ${bound} delayed rows skipped per window, got ` +
        `${delayed.removed} — the scan is sweeping the delayed backlog: ` +
        `claim latency now grows with the delayed rows:\n${delayed.text}`,
    );
  });

  await s.check('a 27k delayed backlog costs at most 3x the buffers of the same rows due', async () => {
    s.assert(
      delayed.buffers <= baseline.buffers * 3,
      `delayed rows must not worsen the claim scan: baseline ${baseline.buffers} buffers ` +
        `vs delayed ${delayed.buffers} buffers`,
    );
  });

  s.log(
    `delayed-heavy: ${delayed.ms} ms / ${delayed.buffers} buffers / ${delayed.removed} rows skipped` +
      `   baseline: ${baseline.ms} ms / ${baseline.buffers} buffers`,
  );
}

await runScenario(
  {
    name: 'claim-scan-bench',
    what: 'the claim candidate scan uses queue_claimable_idx (PF2); delayed rows do not worsen it (PF5)',
    db: { name: 'better_trigger_claim_scan', envVar: 'BT_CLAIM_SCAN_DB' },
  },
  main,
);
