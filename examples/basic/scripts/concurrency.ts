/* =============================================================================
   @better-trigger/example-basic — per-key concurrency limit e2e
   (todos/02-performance.md PF7).

   The limiter's branch in claimRuns — `pg_advisory_xact_lock(classid, hashtext
   ('bt:cc:' || key))` then count the running runs sharing the key — only runs
   when a candidate's task carries `concurrency_limit`. Until this scenario
   existed NO task in the repo set `concurrency.limit` (the `concurrency: 5/2/1`
   the other harnesses pass to daemons is the worker's slot count, a different
   thing), so `t.concurrency_limit` was NULL everywhere and the whole branch —
   advisory lock included — was never executed by any automated test. The unit
   tests around it (packages/kernel/test/concurrency-lock.test.ts) read the SQL
   text off a stub client; they cannot tell whether Postgres actually serializes
   anything.

   What this proves on a real database:

     1. the limit is enforced: 10 runs across 2 keys, 8 execution slots, cap 2
        per key — no key ever has more than 2 runs 'running' at the same time,
        measured twice over (a live sampler polling `runs`, and a post-hoc sweep
        over every run's [started_at, finished_at) window);
     2. it is a limit, not a queue freeze: each key REACHES 2, and the two keys
        overlap past 2 globally — a lock that over-serialized (one global key,
        or two keys colliding) would show a peak of 1 per key or 2 overall;
     3. nothing starves: all 10 runs reach 'completed';
     4. the lock is the one PF7 specifies: the scenario takes
        `pg_advisory_xact_lock(0x62746363, hashtext('bt:cc:<key>'))` itself and
        holds it, then watches (via pg_locks) a real claim transaction BLOCK on
        exactly that (classid, objid, objsubid=2) — and no run of that key start
        — until it commits. That pins the classid, the objid derivation and the
        two-argument form against the live engine, not against a string.

   Note on (4): while the lock is held, claims of OTHER keys stall too — a
   blocked claim transaction is still holding its candidate rows FOR UPDATE, and
   everyone else SKIP LOCKEDs past them. That is why the key-independence half
   of the property is proved by (2), on a free-running engine, rather than by
   triggering a second key under the held lock.

   Runs on @better-trigger/testing: an API node (no --tasks) serves the client
   and runs a reaper, a throwaway registrar executor registers the task and
   leaves, and two executors (4 slots each) do the work. The queue is filled
   BEFORE those two exist, so every slot's very first claim already finds a full
   queue and every claim from then on is contending — rather than trickling in
   at whatever offsets the idle-poll backoff (300ms → 2s) happens to line up.
   The two keys are triggered round-robin so their queue rows interleave: the
   claim scan takes candidates in id order, and a key whose rows all sat behind
   the other key's would only start once the first key was capped.

   Env:
     DATABASE_URL        base connection derived from it; default
                         postgres://localhost:5432/better_trigger
     BT_CONCURRENCY_DB   override the provisioned database name (default
                         better_trigger_concurrency)
     BT_CONCURRENCY_PORT port the API node listens on (default 4906)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  portFromEnv,
  runScenario,
  sleep,
  spawnDaemon,
  startDaemon,
  waitFor,
  waitForTasks,
  type Scenario,
} from '@better-trigger/testing';
import { betterTrigger } from 'better-trigger';
import { CC_LIMIT, ccLimited } from './concurrency-tasks';

const PORT = portFromEnv('BT_CONCURRENCY_PORT', 4906);
const TASKS_MODULE = fileURLToPath(new URL('./concurrency-tasks.ts', import.meta.url));

/** Execution slots per executor; 2 executors → 8 slots for a per-key cap of 2.
 *  A broken limiter has room to run every queued run of a key at once. */
const SLOTS = 4;
const EXECUTORS = 2;
/** Concurrency keys (the tasks module derives them from payload.group). */
const GROUPS = ['cc-alpha', 'cc-beta'] as const;
const RUNS_PER_GROUP = 5;
/** How long each run holds its slot — wide enough that the runs a correct
 *  limiter admits together are still together when the next claim lands. */
const HOLD_MS = 1_200;

/**
 * `classid` of the limiter's advisory locks, duplicated from
 * packages/kernel/src/queue.ts CONCURRENCY_LOCK_CLASS on purpose: this scenario
 * is an independent witness of the namespace PF7 pinned, so it must not read
 * the value from the code it is checking. Both halves of the key derivation are
 * duplicated for the same reason — the `bt:cc:<project>:<env>:<key>` shape
 * below and this constant (the namespace prefix is C2's, so the scenario holds
 * the same (classid, objid) pair the engine's claims contend on for
 * default/prod runs).
 */
const CONCURRENCY_LOCK_CLASS = 0x62_74_63_63; // 'btcc'
/** The key held hostage in step 4; never triggered before that step. */
const GATED_GROUP = 'cc-gamma';

/* ---------------------------------------------------------------------------
 * Measuring overlap
 * ------------------------------------------------------------------------- */

/** One run's 'running' window, as the engine recorded it. */
interface Span {
  runId: string;
  key: string;
  from: number;
  to: number;
}

/**
 * Every finished run of a key, as [started_at, finished_at) in epoch ms. These
 * are the engine's OWN timestamps: started_at is written by the claim that made
 * the run 'running', finished_at by the write that took it terminal — i.e.
 * exactly the window the limiter counts. Read as epoch ms rather than as Date
 * so the sweep below keeps Postgres's microsecond resolution.
 */
async function readSpans(s: Scenario, keys: readonly string[]): Promise<Span[]> {
  const res = await s.pool.query<{
    id: string;
    key: string;
    from_ms: string;
    to_ms: string;
  }>(
    `SELECT id,
            concurrency_key AS key,
            EXTRACT(EPOCH FROM started_at) * 1000 AS from_ms,
            EXTRACT(EPOCH FROM finished_at) * 1000 AS to_ms
       FROM runs
      WHERE concurrency_key = ANY($1::text[])
        AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
    [keys],
  );
  return res.rows.map((r) => ({
    runId: r.id,
    key: r.key,
    from: Number(r.from_ms),
    to: Number(r.to_ms),
  }));
}

/**
 * Largest number of spans alive at any instant. Ends are applied before starts
 * at an equal instant: the windows are half-open, so a run finishing exactly as
 * the next one starts is a hand-off, not an overlap (which is what a cap of N
 * looks like when the engine is fast).
 */
function peakOverlap(spans: Span[]): number {
  const events = spans.flatMap((sp) => [
    { at: sp.from, delta: 1 },
    { at: sp.to, delta: -1 },
  ]);
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let live = 0;
  let peak = 0;
  for (const e of events) {
    live += e.delta;
    if (live > peak) peak = live;
  }
  return peak;
}

interface SampleStats {
  /** Highest simultaneous 'running' count seen per concurrency key. */
  perKey: Map<string, number>;
  /** Highest simultaneous 'running' count seen across all keys at once. */
  peakTotal: number;
  samples: number;
}

/**
 * Live witness, independent of the timestamps the engine writes: poll `runs`
 * for what is 'running' right now and remember the peaks. Sampling can miss a
 * violation between two polls, which is why the span sweep exists — but it also
 * cannot be fooled by a wrong timestamp, which is why both run.
 */
function startSampler(s: Scenario, intervalMs = 20): { stop(): Promise<SampleStats> } {
  const perKey = new Map<string, number>();
  let peakTotal = 0;
  let samples = 0;
  let stopping = false;

  const loop = (async () => {
    while (!stopping) {
      try {
        const res = await s.pool.query<{ key: string; n: number }>(
          `SELECT concurrency_key AS key, count(*)::int AS n
             FROM runs
            WHERE status = 'running' AND concurrency_key IS NOT NULL
            GROUP BY concurrency_key`,
        );
        samples += 1;
        let total = 0;
        for (const row of res.rows) {
          total += row.n;
          perKey.set(row.key, Math.max(perKey.get(row.key) ?? 0, row.n));
        }
        if (total > peakTotal) peakTotal = total;
      } catch {
        // A missed sample is not a failure: the pool may be busy, and the span
        // sweep is the authoritative measurement anyway.
      }
      await sleep(intervalMs);
    }
    return { perKey, peakTotal, samples };
  })();

  return {
    async stop() {
      stopping = true;
      return loop;
    },
  };
}

/** Run a `count(*)::int AS n` query and hand back the number. */
async function countRows(s: Scenario, sql: string, params: unknown[]): Promise<number> {
  const res = await s.pool.query<{ n: number }>(sql, params);
  return res.rows[0]?.n ?? 0;
}

/* ---------------------------------------------------------------------------
 * Scenario
 * ------------------------------------------------------------------------- */

async function main(s: Scenario): Promise<void> {
  /* -- API node: serves the client, keeps a reaper alive -------------------- */
  const api = await startDaemon({ databaseUrl: s.db.url, port: PORT });
  s.cleanup(() => api.stop());
  const client = betterTrigger({ url: api.url! });

  /* -- 1. register the task, then leave the engine without an executor ------ */
  // The registrar exists only to write the tasks row (a trigger is refused for
  // an unregistered task, and concurrency_key is only stamped on a run when the
  // task HAS a limit). It goes away before anything is queued, so the queue can
  // be filled while nothing in the cluster is able to claim.
  const registrar = spawnDaemon({
    databaseUrl: s.db.url,
    tasks: TASKS_MODULE,
    serve: false,
    concurrency: 1,
    name: 'cc-registrar',
  });
  s.cleanup(() => registrar.stop());
  await waitForTasks(s.pool, [ccLimited.id]);
  await registrar.stop();

  const limitRes = await s.pool.query<{ concurrency_limit: number | null }>(
    `SELECT concurrency_limit FROM tasks WHERE id = $1`,
    [ccLimited.id],
  );
  // The check that keeps this scenario from going vacuous: with a NULL limit
  // every assertion below still passes, and nothing is tested. PF7's branch is
  // gated on exactly this column.
  s.assertEqual(limitRes.rows[0]?.concurrency_limit, CC_LIMIT, 'tasks.concurrency_limit');
  s.ok(`${ccLimited.id} registered with concurrency_limit ${CC_LIMIT}, registrar gone`);

  /* -- 2. fill the queue before any slot exists ---------------------------- */
  // Round-robin, so the two keys' queue rows interleave — see the header.
  const runIds: string[] = [];
  for (let i = 0; i < RUNS_PER_GROUP; i += 1) {
    for (const group of GROUPS) {
      const handle = await client.trigger(ccLimited, { group, holdMs: HOLD_MS });
      runIds.push(handle.id);
    }
  }
  // The key is derived SDK-side from the payload and stamped on the run; the
  // limiter counts by that column, so a run without one is invisible to it.
  const keyed = await countRows(
    s,
    `SELECT count(*)::int AS n FROM runs WHERE concurrency_key = ANY($1::text[])`,
    [GROUPS],
  );
  s.assertEqual(keyed, runIds.length, 'queued runs carrying a concurrency key');
  s.ok(`${runIds.length} runs queued across ${GROUPS.length} keys, no executor running`);

  /* -- 3. release every slot onto them at once ----------------------------- */
  const sampler = startSampler(s);
  for (let i = 0; i < EXECUTORS; i += 1) {
    const executor = spawnDaemon({
      databaseUrl: s.db.url,
      tasks: TASKS_MODULE,
      serve: false,
      concurrency: SLOTS,
      name: `cc-executor-${i + 1}`,
    });
    s.cleanup(() => executor.stop());
  }
  s.log(
    `${EXECUTORS} executors × ${SLOTS} slots = ${EXECUTORS * SLOTS} slots ` +
      `for a cap of ${CC_LIMIT} per key`,
  );

  // Generous: 4 runs in flight (the cap, on each of two keys) at 1.2s apiece
  // is ~3s of work, plus two daemon boots. A run that failed can never become
  // 'completed', so say so early rather than spend the whole budget on it.
  await waitFor(`all ${runIds.length} runs to complete`, 120_000, async () => {
    const done = await countRows(
      s,
      `SELECT count(*)::int AS n FROM runs
        WHERE concurrency_key = ANY($1::text[]) AND status = 'completed'`,
      [GROUPS],
    );
    if (done === runIds.length) return true;
    const broken = await countRows(
      s,
      `SELECT count(*)::int AS n FROM runs
        WHERE concurrency_key = ANY($1::text[]) AND status IN ('failed', 'canceled')`,
      [GROUPS],
    );
    return broken > 0 ? { abort: `${broken} run(s) failed or were canceled` } : false;
  });
  const stats = await sampler.stop();
  s.ok(`all ${runIds.length} runs completed — the cap queues runs, it does not starve them`);

  /* -- 4. the cap held, per key, and was actually reached ------------------ */
  const spans = await readSpans(s, GROUPS);
  s.assertEqual(spans.length, runIds.length, 'runs with a measured running window');
  const retried = await countRows(
    s,
    `SELECT count(*)::int AS n FROM runs
      WHERE concurrency_key = ANY($1::text[]) AND attempt <> 1`,
    [GROUPS],
  );
  // A second attempt reuses the first attempt's started_at, so the windows
  // measured above would be wider than any run ever really was.
  s.assertEqual(retried, 0, 'runs that spent a second attempt');

  for (const group of GROUPS) {
    const peak = peakOverlap(spans.filter((sp) => sp.key === group));
    s.assert(
      peak <= CC_LIMIT,
      `key ${group}: ${peak} runs were 'running' at once, limit is ${CC_LIMIT}`,
    );
    s.assert(
      peak === CC_LIMIT,
      `key ${group}: peak concurrency was ${peak}, expected the limit ${CC_LIMIT} to be ` +
        `reached — a limiter that never lets the cap fill is throttling, not limiting`,
    );
    const sampled = stats.perKey.get(group) ?? 0;
    s.assert(
      sampled <= CC_LIMIT,
      `key ${group}: the live sampler saw ${sampled} runs 'running' at once ` +
        `(limit ${CC_LIMIT})`,
    );
    s.ok(`key ${group}: peak concurrency exactly ${CC_LIMIT} (sampler agreed: ${sampled})`);
  }

  // Keys are independent buckets. One global lock — or two keys colliding into
  // one — would cap the whole task at CC_LIMIT instead of CC_LIMIT per key.
  const globalPeak = peakOverlap(spans);
  s.assert(
    globalPeak > CC_LIMIT,
    `${GROUPS.length} keys with a cap of ${CC_LIMIT} each never exceeded ${CC_LIMIT} ` +
      `runs in total (peak ${globalPeak}) — the keys are serializing each other`,
  );
  s.ok(
    `${GROUPS.length} keys ran ${globalPeak} runs concurrently in total ` +
      `(sampler peak ${stats.peakTotal}, ${stats.samples} samples) — keys do not block each other`,
  );

  /* -- 5. the lock is better-trigger's own, on the key PF7 names ----------- */
  // Hold (classid 'btcc', hashtext('bt:cc:default:prod:<key>')) from here and
  // the limiter cannot proceed past its lock: the claim transaction blocks, no
  // run of that key starts, and pg_locks shows it waiting on OUR lock. The key
  // is namespace-qualified (C2) — these runs are default/prod, the same pair
  // the claim computes for them.
  const lockKey = `bt:cc:default:prod:${GATED_GROUP}`;
  const holder = await s.pool.connect();
  let holding = false;
  const release = async (): Promise<void> => {
    if (!holding) return;
    holding = false;
    await holder.query('ROLLBACK').catch(() => {});
    holder.release();
  };
  s.cleanup(release);

  await holder.query('BEGIN');
  await holder.query(`SELECT pg_advisory_xact_lock($1::int4, hashtext($2))`, [
    CONCURRENCY_LOCK_CLASS, lockKey,
  ]);
  holding = true;

  const gated = [
    await client.trigger(ccLimited, { group: GATED_GROUP, holdMs: HOLD_MS }),
    await client.trigger(ccLimited, { group: GATED_GROUP, holdMs: HOLD_MS }),
  ];
  s.log(`holding ${lockKey} under classid ${CONCURRENCY_LOCK_CLASS}; ${gated.length} runs queued`);

  // pg_locks reports advisory locks as (classid, objid, objsubid); objsubid 2
  // is the two-argument form (1 would be the single-bigint form PF7 replaced),
  // and objid is hashtext's int4 widened into the unsigned oid column. `NOT
  // granted` selects the *waiter* rather than the row recording our own hold —
  // and a waiter can only exist here if the claim asked for the very same
  // (classid, objid) in the very same space, which is the whole assertion.
  const waiters = async (): Promise<number> =>
    countRows(
      s,
      `SELECT count(*)::int AS n
         FROM pg_locks
        WHERE locktype = 'advisory' AND objsubid = 2 AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid::bigint = $1
          AND objid::bigint = (hashtext($2)::bigint & 4294967295)`,
      [CONCURRENCY_LOCK_CLASS, lockKey],
    );
  // 30s for something that takes at most one idle-poll cycle (300ms → 2s of
  // backoff): the failure this guards is a claim that never blocks at all —
  // a limiter that dropped the lock, or took it in a different namespace —
  // and waiting longer would not change the verdict, only report it later.
  await waitFor(
    `a claim to block on advisory lock (${CONCURRENCY_LOCK_CLASS}, hashtext('${lockKey}'))`,
    30_000,
    async () => (await waiters()) > 0,
    { intervalMs: 50 },
  );
  s.ok(`a claim transaction is waiting on better-trigger's own lock for ${GATED_GROUP}`);

  // ...and nothing of that key got through while we hold it. started_at is
  // written by the claim itself, so this is "never claimed", not "not finished".
  const startedUnderLock = await countRows(
    s,
    `SELECT count(*)::int AS n FROM runs
      WHERE concurrency_key = $1 AND started_at IS NOT NULL`,
    [GATED_GROUP],
  );
  s.assertEqual(startedUnderLock, 0, `${GATED_GROUP} runs started while the lock was held`);
  s.ok(`${gated.length} ${GATED_GROUP} runs stayed queued for as long as the lock was held`);

  await holder.query('COMMIT');
  holding = false;
  holder.release();

  for (const handle of gated) {
    const result = await client.waitForResult(handle.id, undefined, { timeoutMs: 60_000 });
    s.assert(
      result.status === 'completed',
      `${GATED_GROUP} run ${handle.id} should complete once the lock is released, ` +
        `got '${result.status}'`,
    );
  }
  const gatedSpans = await readSpans(s, [GATED_GROUP]);
  const gatedPeak = peakOverlap(gatedSpans);
  s.assert(
    gatedPeak <= CC_LIMIT,
    `key ${GATED_GROUP}: ${gatedPeak} runs were 'running' at once after the release ` +
      `(limit ${CC_LIMIT})`,
  );
  s.ok(
    `releasing the lock let both ${GATED_GROUP} runs through (peak ${gatedPeak} ≤ ${CC_LIMIT})`,
  );
}

await runScenario(
  {
    name: 'concurrency',
    what: 'per-key concurrency limits are enforced by the advisory lock',
    db: { name: 'better_trigger_concurrency', envVar: 'BT_CONCURRENCY_DB' },
  },
  main,
);
