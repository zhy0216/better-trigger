/* =============================================================================
   better-trigger — instance lifecycle concurrency self-test (bun-runnable).

   Run:  bun packages/sdk/test/lifecycle-selftest.ts
   Needs a local Postgres at postgres://localhost:5432; creates throwaway
   databases named bt_fix_* and drops them on the way out.

   Proves the lifecycle guarantees of the betterTrigger() facade:
     1. ensureReady is not poisoned by a transient migrate failure — a failed
        attempt is retried on the next call; success stays memoized.
     2. defaults.retry reaches BOTH the registration manifest (max_attempts)
        and the executor-reported backoff (queue.available_at spacing).
     3. Concurrent double start(): exactly one rejection, ONE runtime spawned.
     4. A stopped instance (via handle.stop() or instance.stop()) can start()
        again on a borrowed pool, and the borrowed pool is never ended.
     5. Concurrent double stop(): both join the same drain — the in-flight run
        completes before the owned pool ends.
   ============================================================================= */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { betterTrigger, task } from '../src/index.ts';

const BASE = 'postgres://localhost:5432';
const RAND = Math.random().toString(36).slice(2, 8);
const DB_A = `bt_fix_a_${RAND}`;
const DB_B = `bt_fix_b_${RAND}`;
const URL_A = `${BASE}/${DB_A}`;
const URL_B = `${BASE}/${DB_B}`;

/** Fast loop knobs so failures/retries surface quickly. */
const FAST = { timerIntervalMs: 200, cronIntervalMs: 60_000, reaperIntervalMs: 500 };

let failures = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function admin(sql: string): Promise<void> {
  const p = new pg.Pool({ connectionString: `${BASE}/postgres` });
  try {
    await p.query(sql);
  } finally {
    await p.end();
  }
}

async function rejection(p: Promise<unknown>): Promise<Error | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err as Error;
  }
}

/** Poll a predicate over a throwaway inspection pool. */
async function pollDb<T>(
  url: string,
  fn: (pool: pg.Pool) => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T | undefined> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const out = await fn(pool);
      if (out !== undefined) return out;
      if (Date.now() >= deadline) return undefined;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await pool.end();
  }
}

/* ---- tasks ---------------------------------------------------------------- */

const echo = task('selftest-echo', async (p: { v: number }) => ({ echoed: p.v }));

const slow = task('selftest-slow', async (p: { ms: number }, ctx) => {
  await new Promise((r) => setTimeout(r, p.ms));
  await ctx.step('final-step', () => 'drained');
  return 'finished';
});

// No task-level retry on either: they must inherit instance defaults.retry.
const failsTop = task('selftest-fails-top', async () => {
  throw new Error('boom-top');
});
const failsStep = task('selftest-fails-step', async (_p: unknown, ctx) => {
  await ctx.step('s1', () => {
    throw new Error('boom-step');
  });
});

/* ---- 1. ensureReady: failed migrate is retried, not cached ---------------- */

async function testEnsureReadyRecovery(): Promise<void> {
  console.log('[1] ensureReady recovers after a transient migrate failure');
  // DB_A intentionally does not exist yet — the first touch must fail.
  const instance = betterTrigger({ database: { connectionString: URL_A } });

  // Drizzle wraps the pg "database does not exist" error, so match loosely:
  // it must reject, and NOT with the kernel's run-not-found error.
  const err1 = await rejection(instance.getRun(randomUUID()));
  check(err1 !== null && !/not found/i.test(err1.message), 'first call fails: migrate rejected', err1?.message);

  await admin(`CREATE DATABASE ${DB_A}`);

  // Pre-fix this replays the cached rejection; post-fix migrate reruns and the
  // call reaches the kernel (missing run → not_found).
  const err2 = await rejection(instance.getRun(randomUUID()));
  check(err2 !== null && /not found/i.test(err2.message), 'second call retried migrate and hit the kernel', err2?.message);

  // Positive path: the same instance is fully usable end to end.
  await instance.start({ tasks: [echo], concurrency: 2, leaseMs: 10_000 });
  const handle = await instance.trigger(echo, { v: 42 });
  const res = await handle.result({ timeoutMs: 20_000, pollMs: 100 });
  check(res.status === 'completed', 'run completes after recovery', res);
  await instance.stop();
}

/* ---- 2. defaults.retry: manifest AND executor backoff agree --------------- */

async function testDefaultsRetry(): Promise<void> {
  console.log('[2] defaults.retry drives trigger-time max_attempts AND executor backoff');
  const instance = betterTrigger({
    database: { connectionString: URL_A },
    defaults: { retry: { maxAttempts: 3, baseMs: 60_000, factor: 2, maxMs: 300_000 } },
    orchestrator: FAST,
  });
  await instance.start({ tasks: [failsTop, failsStep], concurrency: 2, leaseMs: 10_000 });

  for (const t of [failsTop, failsStep]) {
    const h = await instance.trigger(t, {});
    const row = await pollDb(URL_A, async (pool) => {
      const r = await pool.query(
        `SELECT r.attempt, r.max_attempts, r.status,
                extract(epoch from (q.available_at - now())) AS delay_s
           FROM runs r LEFT JOIN queue q ON q.run_id = r.id
          WHERE r.id = $1`,
        [h.id],
      );
      const row0 = r.rows[0];
      return row0 && row0.attempt >= 2 && row0.status === 'queued' ? row0 : undefined;
    });
    check(row !== undefined, `${t.id}: first failure re-queued`, row);
    if (!row) continue;
    check(Number(row.max_attempts) === 3, `${t.id}: max_attempts from defaults.retry`, row.max_attempts);
    const delay = Number(row.delay_s);
    // baseMs 60s with ±20% jitter → [48s, 72s]; DEFAULT_RETRY would be ~1s.
    check(delay > 40 && delay < 80, `${t.id}: backoff uses defaults.retry baseMs (~60s)`, delay);
  }
  await instance.stop();
}

/* ---- 3. concurrent double start(): one rejection, ONE runtime ------------- */

async function testDoubleStart(): Promise<void> {
  console.log('[3] concurrent start() x2: exactly one throws, one runtime spawned');
  await admin(`CREATE DATABASE ${DB_B}`);
  const instance = betterTrigger({ database: { connectionString: URL_B } });
  const sigintBefore = process.listenerCount('SIGINT');

  const settled = await Promise.allSettled([
    instance.start({ tasks: [echo], concurrency: 1, leaseMs: 10_000 }),
    instance.start({ tasks: [echo], concurrency: 1, leaseMs: 10_000 }),
  ]);
  const fulfilled = settled.filter((s) => s.status === 'fulfilled');
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  check(fulfilled.length === 1 && rejected.length === 1, 'exactly one start() throws', settled.map((s) => s.status));
  check(
    rejected.length === 1 && /already started/.test(String(rejected[0].reason?.message)),
    'rejection says worker already started',
    rejected[0]?.reason?.message,
  );

  const workerRows = await pollDb(URL_B, async (pool) => {
    const r = await pool.query(`SELECT count(*)::int AS n FROM workers`);
    return r.rows[0].n as number;
  }, 2_000);
  check(workerRows === 1, 'exactly ONE worker registered', workerRows);
  check(process.listenerCount('SIGINT') - sigintBefore === 1, 'exactly ONE runtime holds signal handlers');

  await instance.stop();
  check(process.listenerCount('SIGINT') - sigintBefore === 0, 'signal handlers released after stop');
}

/* ---- 4. restart after stop on a borrowed pool ----------------------------- */

async function testRestartOnBorrowedPool(): Promise<void> {
  console.log('[4] stopped instance restarts on a borrowed pool (handle.stop and instance.stop paths)');
  const shared = new pg.Pool({ connectionString: URL_B });
  const instance = betterTrigger({ database: shared });

  const h1 = await instance.start({ tasks: [echo], concurrency: 1, leaseMs: 10_000 });
  await h1.stop(); // stop via the WorkerHandle — must release the start slot
  const again = await rejection(instance.start({ tasks: [echo], concurrency: 1, leaseMs: 10_000 }));
  check(again === null, 'start() succeeds again after handle.stop()', again?.message);

  const r1 = await instance.trigger(echo, { v: 1 });
  check((await r1.result({ timeoutMs: 20_000, pollMs: 100 })).status === 'completed', 'second runtime executes runs');

  await instance.stop(); // instance path this time
  const third = await rejection(instance.start({ tasks: [echo], concurrency: 1, leaseMs: 10_000 }));
  check(third === null, 'start() succeeds again after instance.stop()', third?.message);
  const r2 = await instance.trigger(echo, { v: 2 });
  check((await r2.result({ timeoutMs: 20_000, pollMs: 100 })).status === 'completed', 'third runtime executes runs');
  await instance.stop();

  const alive = await rejection(shared.query('SELECT 1'));
  check(alive === null, 'borrowed pool never ended by instance.stop()', alive?.message);
  await shared.end();
}

/* ---- 5. concurrent stop() x2 drains before the owned pool ends ------------ */

async function testDoubleStop(): Promise<void> {
  console.log('[5] concurrent stop() x2: in-flight run drains before pool end');
  const instance = betterTrigger({ database: { connectionString: URL_B }, orchestrator: FAST });
  await instance.start({ tasks: [slow], concurrency: 2, leaseMs: 10_000 });
  const h = await instance.trigger(slow, { ms: 1_500 });

  const running = await pollDb(URL_B, async (pool) => {
    const r = await pool.query(`SELECT status FROM runs WHERE id = $1`, [h.id]);
    return r.rows[0]?.status === 'running' ? true : undefined;
  });
  check(running === true, 'run is in flight before stopping');

  // Same tick — pre-fix the second stop() skipped the drain and ended the pool
  // under the in-flight run.
  const stops = await Promise.allSettled([instance.stop(), instance.stop()]);
  check(stops.every((s) => s.status === 'fulfilled'), 'both stop() calls resolve', stops.map((s) => s.status));

  const final = await pollDb(URL_B, async (pool) => {
    const r = await pool.query(`SELECT status, output FROM runs WHERE id = $1`, [h.id]);
    return r.rows[0];
  }, 2_000);
  check(final?.status === 'completed', 'in-flight run completed during the drain', final);
}

/* ---- main ----------------------------------------------------------------- */

async function main(): Promise<void> {
  await admin(`DROP DATABASE IF EXISTS ${DB_A} WITH (FORCE)`);
  await admin(`DROP DATABASE IF EXISTS ${DB_B} WITH (FORCE)`);
  try {
    await testEnsureReadyRecovery();
    await testDefaultsRetry();
    await testDoubleStart();
    await testRestartOnBorrowedPool();
    await testDoubleStop();
  } finally {
    await admin(`DROP DATABASE IF EXISTS ${DB_A} WITH (FORCE)`);
    await admin(`DROP DATABASE IF EXISTS ${DB_B} WITH (FORCE)`);
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall lifecycle checks passed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('selftest crashed:', err);
  try {
    await admin(`DROP DATABASE IF EXISTS ${DB_A} WITH (FORCE)`);
    await admin(`DROP DATABASE IF EXISTS ${DB_B} WITH (FORCE)`);
  } catch {}
  process.exit(1);
});
