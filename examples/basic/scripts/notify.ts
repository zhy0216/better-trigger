/* =============================================================================
   @better-trigger/example-basic — notification fast-path e2e (PF2,
   todos/02-performance.md).

   Two daemons against one database, exactly like production: an API node that
   serves the client, and an executor node that claims and runs. Both LISTEN on
   the `bt` channel; the kernel write paths notify inside their transactions.

   Checks:

     1. claim wake — after the executor's single claim slot has idled past its
        max 2s backoff, a fresh trigger is claimed in well under a second
        (a work notification woke the sleep), and the executor's own metrics
        show claim_wakes_total ≥ 1 — the direct proof the notification path
        fired, not just the timing.
     2. waiter registry — 8 concurrent HTTP result() waiters against one slow
        run all resolve 'completed' at the run's terminal event (not at their
        3s timeout), and the API node's waiter_resolutions_total jumps by 8:
        the in-process registry settled them, one shared poll per process
        instead of 8 independent 4-QPS loops.
     3. LISTEN loss — terminating the daemons' LISTEN backends out from under
        them must not stop the system: a run triggered into the dead window
        (before any reconnect can land) still completes via the polling
        fallback, and the connections then re-establish themselves
        (listen_reconnects_total ≥ 1).
     4. duplicate notifications — blasting extra work + terminal notifications
        at a fresh run must not duplicate execution: it completes once, on
        attempt 1, with the marker file proving the step ran exactly once.

   Env:
     DATABASE_URL  base connection derived from it; default
                   postgres://localhost:5432/better_trigger
     BT_NOTIFY_DB  override the provisioned database name
     BT_NOTIFY_PORT   the API node's port (default 4907)
     BT_NOTIFY_EXEC_PORT the executor node's port (default 4908)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  createMarker,
  portFromEnv,
  runScenario,
  sleep,
  startDaemon,
  waitFor,
  waitForTasks,
  type Scenario,
} from '@better-trigger/testing';
import { betterTrigger } from 'better-trigger';

const PORT = portFromEnv('BT_NOTIFY_PORT', 4907);
const EXEC_PORT = portFromEnv('BT_NOTIFY_EXEC_PORT', 4908);
const TASKS_MODULE = fileURLToPath(new URL('./notify-tasks.ts', import.meta.url));

/** Scrape one unlabelled counter from a daemon's /metrics. */
async function counter(baseUrl: string, name: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/v1/metrics`);
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith(`better_trigger_${name} `));
  return line === undefined ? 0 : Number(line.split(' ')[1]);
}

async function main(s: Scenario): Promise<void> {
  const marker = createMarker('bt-notify');
  s.log(`marker ${marker.file}`);

  // API node: serves the client + the waiter registry the result() waiters
  // land on. Also LISTENs, but claims nothing (no --tasks).
  const api = await startDaemon({ databaseUrl: s.db.url, port: PORT, reaperIntervalMs: 500 });
  s.cleanup(() => api.stop());
  const client = betterTrigger({ url: api.url! });

  // Executor node: the one with a claim loop, served so its metrics are
  // scrapeable (the claim-wake proof lives there).
  const executor = await startDaemon({
    databaseUrl: s.db.url,
    tasks: TASKS_MODULE,
    port: EXEC_PORT,
    concurrency: 1,
    leaseMs: 10_000,
    env: marker.env,
  });
  s.cleanup(() => executor.stop());

  await waitForTasks(s.pool, ['notify-fast', 'notify-slow', 'notify-marker']);
  s.ok('executor up, notify tasks registered');

  // Let the single claim slot idle past its max backoff (300ms → 2s), so a
  // fresh trigger can only be claimed fast because a notification woke it.
  await sleep(4_500);

  /* ---- 1. claim wake: no waiting out the idle backoff --------------------- */
  await s.check('a work notification claims a fresh run without the idle backoff', async () => {
    const wakesBefore = await counter(executor.url!, 'claim_wakes_total');
    const t0 = Date.now();
    const handle = await client.trigger('notify-fast', { v: 1 });
    await waitFor(
      `run ${handle.id} to leave 'queued'`,
      5_000,
      async () => {
        const rec = await s.pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [handle.id],
        );
        return rec.rows[0]!.status !== 'queued';
      },
      { intervalMs: 20 },
    );
    const elapsed = Date.now() - t0;
    s.assert(
      elapsed < 1_000,
      `run claimed in ${elapsed}ms — expected < 1000ms (the idle backoff alone would take up to 2s)`,
    );
    const result = await client.waitForResult(handle.id, undefined, { timeoutMs: 10_000 });
    s.assert(result.status === 'completed', `run completed, got '${result.status}'`);
    // Delta proof, not just "≥ 1": this trigger's notification must be what
    // woke the loop. Without the notification path the counter would not move
    // and the claim would have to wait out the backoff.
    const wakesAfter = await counter(executor.url!, 'claim_wakes_total');
    s.assert(
      wakesAfter >= wakesBefore + 1,
      `claim_wakes_total must increase by this trigger (${wakesBefore} → ${wakesAfter})`,
    );
    s.ok(
      `claimed in ${elapsed}ms, claim_wakes_total ${wakesBefore} → ${wakesAfter} ` +
        '(the work notification woke the sleep)',
    );
  });

  /* ---- 2. parallel result() waiters resolve via the registry -------------- */
  await s.check('N concurrent result() waiters settle at the terminal event', async () => {
    const before = await counter(api.url!, 'waiter_resolutions_total');
    const handle = await client.trigger('notify-slow', { waitMs: 1_500 });
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.waitForResult(handle.id, undefined, { timeoutMs: 3_000 }),
      ),
    );
    const elapsed = Date.now() - t0;
    for (const r of results) {
      s.assert(r.status === 'completed', `waiter resolved '${r.status}', expected 'completed'`);
    }
    s.assert(
      elapsed < 2_500,
      `8 waiters resolved in ${elapsed}ms — before their 3s timeout, so at the run's terminal event`,
    );
    // All 8 were settled by the in-process registry (not by per-request polls).
    await waitFor('registry resolutions to land', 5_000, async () => {
      return (await counter(api.url!, 'waiter_resolutions_total')) >= before + 8;
    });
    s.ok(`8 waiters resolved in ${elapsed}ms via the registry (+8 waiter_resolutions)`);
  });

  /* ---- 3. LISTEN loss: polling fallback, then reconnect ------------------ */
  await s.check('killing the LISTEN connection degrades to polling and reconnects', async () => {
    const res = await s.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE query LIKE 'LISTEN %' AND datname = current_database()
          AND backend_type = 'client backend'`,
    );
    s.assert(res.rows.length >= 1, `expected ≥1 LISTEN backend, got ${res.rows.length}`);
    for (const r of res.rows) {
      await s.pool.query(`SELECT pg_terminate_backend($1)`, [r.pid]);
    }
    s.ok(`terminated ${res.rows.length} LISTEN backend(s)`);

    // Trigger into the dead window — BEFORE any reconnect can land (the
    // daemon's reconnect backoff starts at 1s, so the trigger's notification
    // is guaranteed lost). The run must still complete: the claim loop's
    // polling covers the gap. This proves recovery DURING the outage, not
    // just after it.
    const handle = await client.trigger('notify-fast', { v: 2 });
    const t0 = Date.now();
    const result = await client.waitForResult(handle.id, undefined, { timeoutMs: 10_000 });
    const elapsed = Date.now() - t0;
    s.assert(result.status === 'completed', `run completed, got '${result.status}'`);
    s.assert(result.output === 'fast-done', `output = ${JSON.stringify(result.output)}`);
    s.assert(
      elapsed < 6_000,
      `run completed in ${elapsed}ms — bounded by the polling fallback, not lost`,
    );

    // The connection must come back on its own (with a re-issued LISTEN).
    await waitFor('LISTEN reconnect', 20_000, async () => {
      return (await counter(executor.url!, 'listen_reconnects_total')) >= 1;
    });
    s.ok(
      `run completed in ${elapsed}ms while LISTEN was down; ` +
        'executor re-established its connection afterwards',
    );
  });

  /* ---- 4. duplicate notifications do not duplicate execution -------------- */
  await s.check('duplicate notifications never duplicate a run', async () => {
    const handle = await client.trigger('notify-marker', { v: 3 });
    // Blast duplicates at the run while it is queued/running: two extra work
    // notifications (claim loop wakes that must find nothing new to do) and
    // an early terminal notification (registry has no waiter, must be a no-op).
    await s.pool.query(`SELECT pg_notify('bt', $1)`, [JSON.stringify({ type: 'work' })]);
    await s.pool.query(`SELECT pg_notify('bt', $1)`, [JSON.stringify({ type: 'work' })]);
    await s.pool.query(
      `SELECT pg_notify('bt', $1)`,
      [JSON.stringify({ type: 'terminal', runId: handle.id, projectId: 'default', env: 'prod' })],
    );
    const result = await client.waitForResult(handle.id, undefined, { timeoutMs: 10_000 });
    s.assert(result.status === 'completed', `run completed, got '${result.status}'`);
    const run = await s.pool.query<{ attempt: number; status: string }>(
      `SELECT attempt, status FROM runs WHERE id = $1`,
      [handle.id],
    );
    s.assert(run.rows[0]!.status === 'completed', 'run row is completed');
    s.assert(
      run.rows[0]!.attempt === 1,
      `duplicate notifications must not cost an attempt, got ${run.rows[0]!.attempt}`,
    );
    const ran = marker.count('ran');
    s.assert(ran === 1, `marker has ${ran} "ran" line(s), expected exactly 1`);

    // Post-completion duplicates must be no-ops too: the run is terminal, no
    // waiter is pending, and the registry/claim loops have nothing left to
    // settle — the run must not move again.
    await s.pool.query(`SELECT pg_notify('bt', $1)`, [JSON.stringify({ type: 'work' })]);
    await s.pool.query(
      `SELECT pg_notify('bt', $1)`,
      [JSON.stringify({ type: 'terminal', runId: handle.id, projectId: 'default', env: 'prod' })],
    );
    await sleep(300); // let any spurious wake/settle land
    const after = await s.pool.query<{ attempt: number; status: string }>(
      `SELECT attempt, status FROM runs WHERE id = $1`,
      [handle.id],
    );
    s.assert(
      after.rows[0]!.status === 'completed' && after.rows[0]!.attempt === 1,
      'run unchanged after post-completion duplicate notifications',
    );
    s.assert(marker.count('ran') === 1, 'marker unchanged after post-completion duplicates');
    s.ok('run executed exactly once (attempt 1, marker ×1) under duplicate notifications');
  });
}

await runScenario(
  {
    name: 'notify',
    what: 'notification fast-path: claim wake, waiter registry, LISTEN loss, duplicate-safety (PF2)',
    db: { name: 'better_trigger_notify', envVar: 'BT_NOTIFY_DB' },
  },
  main,
);
