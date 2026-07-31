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

/**
 * Mirrors the candidate SELECT in packages/kernel/src/queue.ts (claimRuns).
 * Kept as a copy on purpose: the kernel does not export its SQL, and EXPLAIN
 * needs the statement text. If the claim query changes shape, change it here
 * too — a bench measuring a query nobody runs proves nothing.
 */
const CANDIDATE_SQL = `SELECT q.id AS queue_id, q.run_id,
          r.task_id, r.payload, r.attempt, r.max_attempts,
          r.code_version, r.env, r.concurrency_key,
          t.concurrency_limit
     FROM queue q
     JOIN runs r ON r.id = q.run_id
     LEFT JOIN tasks t ON t.id = r.task_id
    WHERE q.available_at <= now() AND q.locked_by IS NULL
      AND r.task_id = ANY($1::text[])
    ORDER BY q.priority DESC, q.id ASC
    LIMIT $2
    FOR UPDATE OF q SKIP LOCKED`;

const taskIds = Array.from({ length: TASKS }, (_, i) => `task-${i}`);

interface Plan {
  /** The plan as EXPLAIN printed it, joined back into one block. */
  text: string;
  /** `Buffers: shared hit=N` on the top node — the whole query's page reads. */
  buffers: number;
  /** Top-node `Execution Time`, in ms. */
  ms: number;
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
        await client.query(CANDIDATE_SQL, [taskIds, WINDOW]);
        await client.query('ROLLBACK');
      }
      await client.query('BEGIN');
      const res = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${CANDIDATE_SQL}`,
        [taskIds, WINDOW],
      );
      await client.query('ROLLBACK');
      const text = res.rows.map((r) => r['QUERY PLAN']).join('\n');
      console.log(`\n----- ${label} -----\n${text}\n`);
      return {
        text,
        buffers: Number(text.match(/Buffers: shared hit=(\d+)/)?.[1] ?? 0),
        ms: Number(text.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? 0),
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
}

await runScenario(
  {
    name: 'claim-scan-bench',
    what: 'the claim candidate scan uses queue_claimable_idx (PF2)',
    db: { name: 'better_trigger_claim_scan', envVar: 'BT_CLAIM_SCAN_DB' },
  },
  main,
);
