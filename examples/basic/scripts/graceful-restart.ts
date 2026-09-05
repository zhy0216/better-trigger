/* =============================================================================
   @better-trigger/example-basic — graceful-restart e2e (C3: shutdown hands the
   claims back instead of leaving them to expire).

   Pins what a normal deploy costs. Before C3 a SIGTERM left the undrained run
   holding `locked_by` and a live lease, so nothing could touch it until the
   lease expired (60s) and the reaper's next tick noticed (10s) — and the
   reaper's recovery path charges the run a `recovery` (C4; before C4 it was an
   `attempt`, i.e. the user's own retry budget). This scenario asserts all of
   that is gone: neither counter moves and the handover is immediate.

   Runs on @better-trigger/testing (runScenario provisions + migrates the
   database) with an API node (no --tasks) that serves the scenario's client,
   plus two executor nodes (--tasks graceful-restart-tasks.ts) that also serve
   HTTP on a second port (RESULT_PORT), so the SDK's result() client talks to
   whichever executor is currently up. Executor #1 gets SIGTERMed mid-run;
   executor #2 binds the same port after it exits.

   The lease (60s) and every reaper interval (60s) are set LONGER than the whole
   scenario on purpose: nothing here can be rescued by expiry, so a run that
   gets picked up seconds after the restart was handed over deliberately.

   Flow: spawn executor #1 → trigger gr-restart (retry { maxAttempts: 1 }) →
   wait until it is parked on ctx.signal past step1 → park an SDK result() on
   executor #1's waiter registry → SIGTERM the executor and wait for it to exit
   → inspect the ledger with NO worker alive → spawn executor #2 → the run
   finishes and the parked result() resolves with its terminal state.

   Asserts, with the daemon already gone:
     - the queue row is free: locked_by / locked_at / lease_until NULL and
       available_at already due
     - runs.attempt is STILL 1, runs.recoveries is STILL 0, and the run is back
       to 'queued' — a handover is neither a failure (a spent retry) nor an
       infrastructure recovery (a spent recovery)
     - the workers row is 'offline' immediately, not in two minutes
   and after executor #2:
     - the run completes well inside the lease, attempt still 1
     - step1 ran exactly once across the restart, step2 exactly once, and the
       body was entered twice (the pure marker line)
     - the shared ledger invariants hold

   ③ the SDK contract (p0-03): an SDK result() parked on the restarting
   daemon's waiter registry is abandoned at shutdown (WaiterRegistryStoppedError
   → HTTP 503 waiter_abandoned), the SDK backs off and retries the same URL,
   gets connection-refused while no executor is up, and resolves with the run's
   terminal state once executor #2 serves RESULT_PORT and finishes the run — a
   restart never turns an in-flight result() into an error.

   Env:
     DATABASE_URL              base connection derived from it; default
                               postgres://localhost:5432/better_trigger
     BT_GRACEFUL_RESTART_DB    override the database name prefix
                               (default better_trigger_graceful_restart)
     BT_GRACEFUL_RESTART_PORT  port the API node listens on (default 4905)
     BT_GRACEFUL_RESTART_RESULT_PORT
                               port the executors serve HTTP on (default 4906)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  freePort,
  createMarker,
  runScenario,
  sleep,
  spawnDaemon,
  startDaemon,
  waitFor,
  waitForTasks,
  type Daemon,
  type Scenario,
} from '@better-trigger/testing';
import { betterTrigger } from 'better-trigger';

// P2-35: freePort() defaults so the two restart scenarios cannot collide.
const PORT =
  process.env.BT_GRACEFUL_RESTART_PORT !== undefined
    ? Number(process.env.BT_GRACEFUL_RESTART_PORT)
    : await freePort();
const RESULT_PORT =
  process.env.BT_GRACEFUL_RESTART_RESULT_PORT !== undefined
    ? Number(process.env.BT_GRACEFUL_RESTART_RESULT_PORT)
    : await freePort();
const TASKS_MODULE = fileURLToPath(new URL('./graceful-restart-tasks.ts', import.meta.url));

/** Longer than this scenario takes: expiry must never be what rescues the run. */
const LEASE_MS = 60_000;
const REAPER_MS = 60_000;

interface QueueRow {
  locked_by: string | null;
  locked_at: Date | null;
  lease_until: Date | null;
  due: boolean;
}

async function main(s: Scenario): Promise<void> {
  const marker = createMarker('bt-graceful-restart');
  s.log(`marker ${marker.file}`);

  const spawnExecutor = (): Daemon =>
    spawnDaemon({
      databaseUrl: s.db.url,
      tasks: TASKS_MODULE,
      // A serving executor also claims runs (same as --no-serve + a claim
      // loop): serve HTTP on RESULT_PORT so the SDK's result() client can park
      // a waiter on whatever executor currently owns the run.
      serve: true,
      port: RESULT_PORT,
      concurrency: 1,
      leaseMs: LEASE_MS,
      reaperIntervalMs: REAPER_MS,
      env: marker.env,
    });

  // The API node serves the client; its reaper is deliberately too slow to be
  // the thing that requeues anything inside this scenario.
  const api = await startDaemon({
    databaseUrl: s.db.url,
    port: PORT,
    reaperIntervalMs: REAPER_MS,
  });
  s.cleanup(() => api.stop());
  const client = betterTrigger({ url: api.url! });
  // Second client pointed at the executors' serving port: the whole point of
  // this scenario is that a result() parked HERE survives the restart below.
  const resultClient = betterTrigger({ url: `http://localhost:${RESULT_PORT}` });

  /* -- boot executor #1 and park a run inside it --------------------------- */
  let proc = spawnExecutor();
  s.cleanup(() => proc.stop());

  await waitForTasks(s.pool, ['gr-restart']);
  const workerRes = await s.pool.query<{ id: string }>(`SELECT id FROM workers`);
  s.assert(
    workerRes.rows.length === 1,
    `expected exactly 1 registered worker (the executor), got ${workerRes.rows.length}`,
  );
  const workerId = workerRes.rows[0]!.id;
  s.ok(`executor #1 up as worker ${workerId}, gr-restart registered`);

  const payload = { note: 'restart-me' };
  const handle = await client.trigger('gr-restart', payload);
  s.log(`run: ${handle.id}`);

  await waitFor('"pass" marker line (run parked past step1)', 30_000, () =>
    marker.count('pass') >= 1,
  );

  const readQueue = async (): Promise<QueueRow | undefined> => {
    const res = await s.pool.query<QueueRow>(
      `SELECT locked_by, locked_at, lease_until, available_at <= now() AS due
         FROM queue WHERE run_id = $1`,
      [handle.id],
    );
    return res.rows[0];
  };

  const claimed = await readQueue();
  s.assert(
    claimed?.locked_by === workerId,
    `run should be claimed by ${workerId} before the restart, got ${claimed?.locked_by}`,
  );
  s.assert(claimed?.lease_until != null, 'claimed run should hold a lease before the restart');
  s.ok(`run claimed by executor #1 with a live ${LEASE_MS / 1000}s lease`);

  /* -- park an SDK result() on the daemon about to be killed ---------------- */
  // p0-03: an in-flight result() during the restart must resolve with the
  // terminal state, NOT reject. Start it now, on executor #1's waiter registry
  // — the 1.5s beat below lets the long-poll actually land before the SIGTERM.
  // The 40s budget covers: 503 waiter_abandoned from executor #1's drain →
  // SDK backoff + retry → connection-refused while no executor is up → executor
  // #2 binds RESULT_PORT and takes the run over. A rejection here would fail
  // the scenario outright.
  const resultPromise = resultClient.waitForResult(handle.id, undefined, { timeoutMs: 40_000 });
  await sleep(1_500);

  /* -- the deploy: SIGTERM, wait for the process to be gone ---------------- */
  const restartedAt = Date.now();
  await proc.stop();
  s.ok('SIGTERM — executor #1 drained and exited while holding the run');

  /* -- the ledger, with no worker alive to touch it ------------------------ */
  const freed = await readQueue();
  s.assert(freed !== undefined, 'the queue row must survive the restart (nothing is lost)');
  s.assert(
    freed!.locked_by === null && freed!.locked_at === null && freed!.lease_until === null,
    `claim should be released on shutdown, got locked_by=${freed!.locked_by} ` +
      `lease_until=${freed!.lease_until?.toISOString() ?? 'null'}`,
  );
  s.assert(freed!.due, 'released run should be immediately available, not parked behind a delay');
  s.ok('queue row handed back: no owner, no lease, available now');

  const afterStop = await client.getRun(handle.id);
  s.assert(
    afterStop.attempt === 1,
    `a clean restart must not spend a retry: expected attempt 1, got ${afterStop.attempt}`,
  );
  s.assert(
    afterStop.status === 'queued',
    `released run should be back to 'queued', got '${afterStop.status}'`,
  );
  // The other budget (C4): a handover is not an infrastructure recovery
  // either, so the reaper's counter must be untouched as well — otherwise
  // enough deploys would still eventually declare the run 'worker lost'.
  const recovered = await s.pool.query<{ recoveries: number }>(
    `SELECT recoveries FROM runs WHERE id = $1`,
    [handle.id],
  );
  s.assert(
    recovered.rows[0]?.recoveries === 0,
    `a clean restart must not spend a recovery either, got ${recovered.rows[0]?.recoveries}`,
  );
  s.ok(`attempt AND recoveries untouched, run back to 'queued' — a handover, not a failure`);

  const workerAfter = await s.pool.query<{ status: string }>(
    `SELECT status FROM workers WHERE id = $1`,
    [workerId],
  );
  s.assert(
    workerAfter.rows[0]?.status === 'offline',
    `worker should be 'offline' right after the restart, got '${workerAfter.rows[0]?.status}'`,
  );
  s.ok(`worker ${workerId} marked offline immediately (not in 2 minutes)`);

  /* -- executor #2 picks the run up and finishes it ------------------------ */
  proc = spawnExecutor();
  // The result() we started on executor #1's waiter registry BEFORE the SIGTERM
  // is the same call we now await: it was abandoned (503 waiter_abandoned),
  // retried with backoff, hit connection-refused while no executor served
  // RESULT_PORT, and lands on executor #2 the moment it binds the port. It must
  // resolve with the terminal state — a rejection here fails the scenario.
  const result = await resultPromise;
  const elapsed = Date.now() - restartedAt;

  s.assert(result.status === 'completed', `run should complete, got '${result.status}'`);
  s.assert(
    elapsed < LEASE_MS,
    `takeover took ${elapsed}ms, which is not faster than the ${LEASE_MS}ms lease it is ` +
      `supposed to make unnecessary`,
  );
  s.ok(`executor #2 took over and completed the run in ${(elapsed / 1000).toFixed(1)}s`);

  const detail = await client.getRunDetail(handle.id);
  s.assertEqual(result.output, payload, 'run output');
  s.assert(
    detail.run.attempt === 1,
    `attempt must still be 1 after the handover, got ${detail.run.attempt}`,
  );
  s.ok('run completed on attempt 1 — the restart cost no retry budget');

  s.assertEqual(marker.count('step1'), 1, 'step1 side effects across the restart');
  s.assertEqual(marker.count('step2'), 1, 'step2 side effects across the restart');
  s.assertEqual(marker.count('pass'), 2, 'passes through the (non-durable) run body');
  s.ok('durable steps stayed exactly-once while the body replayed once');

  /* -- shared ledger invariants -------------------------------------------- */
  await s.inv.assertSeqContiguous(handle.id, { kinds: ['step', 'step'] });
  await s.inv.assertNoStepRewrites(handle.id);
  await s.inv.assertTerminalImmutable(handle.id);
  s.ok('invariants: gap-free ledger, append-only, terminal state frozen');
}

await runScenario(
  {
    name: 'graceful-restart',
    what: 'a clean SIGTERM hands the claim back without spending an attempt',
    db: { name: 'better_trigger_graceful_restart', envVar: 'BT_GRACEFUL_RESTART_DB' },
  },
  main,
);
