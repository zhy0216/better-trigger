/* =============================================================================
   @better-trigger/example-basic — a stalled orchestrator loop self-heals
   (todos/p1-11).

   The orchestrator's wait-due scanner (scanWaits) takes its per-wait resume
   locks in the canonical kernel order, and position 1 — the queue row's
   blocking `FOR UPDATE` — is BLOCKING by design (a suspended run has no queue
   row, so it is normally a 0-row no-op; holding it is what stops the closing
   INSERT ... ON CONFLICT from inverting 2→1). Before p1-11 nothing bounded
   that statement: a queue row that stayed locked (a stuck peer, a manual
   transaction) would leave the loop's tick blocked forever, the re-entrancy
   guard would swallow every later tick, and loopErrors would stay 0 — a
   silently dead waits loop with zero metrics.

   The daemon's business pool now sends statement_timeout in the connection
   startup packet, so PostgreSQL itself cancels the blocked statement and the
   loop's catch increments loopErrors.waits on the NEXT tick. This scenario
   proves that self-healing on a live Postgres:

     a. hold a queue row's FOR UPDATE lock from a scenario client (the run is
        'waiting' with a due duration wait, so the scanner keeps trying to
        resume it);
     b. with BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS=2000 the blocked resume
        statement is cancelled ~2s later — better_trigger_orchestrator_errors_total
        {loop="waits"} climbs to 1 instead of the loop dying silently;
     c. the stall is visible: better_trigger_loop_last_success_timestamp
        {loop="waits"} stays frozen while the lock is held (the gauge reflects
        the pause) — a loop with NO statement_timeout would look identical here,
        which is exactly the point of the error counter next to it;
     d. releasing the lock lets the very next tick resume the run: the timestamp
        starts advancing again (two scrapes a second apart, strictly increasing)
        and the run leaves 'waiting' and completes.

   Env:
     DATABASE_URL        base connection derived from it; default
                         postgres://localhost:5432/better_trigger
     BT_LOOP_HANG_DB     override the database name prefix (default
                         better_trigger_loop_hang)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import {
  freePort,
  runScenario,
  sleep,
  spawnDaemon,
  waitFor,
  waitForHealth,
  waitForTasks,
  type Scenario,
} from '@better-trigger/testing';
import { LOOP_HANG_TASK_ID } from './loop-hang-tasks';

/** Server-side statement timeout for the daemon's business pool: short on
 *  purpose, so the blocked resume statement is cancelled ~2s after the tick
 *  starts and the whole scenario stays bounded. */
const STATEMENT_TIMEOUT_MS = 2000;
/** How long the queue-row lock is held and the loop is observed frozen. */
const FROZEN_OBSERVE_MS = 1500;
/** Gap between the two post-release scrapes; > 1s (the waits tick interval),
 *  so at least one successful tick must land strictly between them. */
const ADVANCE_OBSERVE_MS = 1500;

const TASKS_MODULE = fileURLToPath(new URL('./loop-hang-tasks.ts', import.meta.url));

/** One metric sample out of a scrape: `name{label="v",...} value`. */
async function scrapeMetric(
  url: string,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const res = await fetch(`${url}/api/v1/metrics`);
  if (!res.ok) throw new Error(`metrics scrape returned ${res.status}`);
  const body = await res.text();
  const inner = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  const re = new RegExp(`^${name}\\{${inner}\\}\\s+(\\S+)`, 'm');
  const m = re.exec(body);
  if (!m) throw new Error(`metric ${name}{${inner}} missing from the scrape`);
  return Number(m[1]);
}

/** Cancelled-or-blocked scanWaits ticks, the loop's error counter. */
function readWaitsErrors(url: string): Promise<number> {
  return scrapeMetric(url, 'better_trigger_orchestrator_errors_total', { loop: 'waits' });
}

/** Epoch ms of the waits loop's last completed tick — frozen while stalled. */
function readWaitsLastSuccess(url: string): Promise<number> {
  return scrapeMetric(url, 'better_trigger_loop_last_success_timestamp', { loop: 'waits' });
}

async function main(s: Scenario): Promise<void> {
  /* -- a task-serving daemon with a 2s server-side statement timeout --------- */
  // The waits loop only runs on a daemon that has tasks (a bookkeeping-only
  // daemon turns it off on purpose), so the scenario hands it the trivial
  // loop-hang-tasks module and the seeded run's task id matches it — the
  // resumed run can then be claimed and completed end to end.
  const daemon = spawnDaemon({
    databaseUrl: s.db.url,
    port: await freePort(),
    tasks: TASKS_MODULE,
    env: { BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS: String(STATEMENT_TIMEOUT_MS) },
  });
  try {
    await waitForHealth(daemon.url!);
    await waitForTasks(s.pool, [LOOP_HANG_TASK_ID]);
  } catch (err) {
    await daemon.stop();
    throw err;
  }
  s.log(
    `daemon up with statement_timeout=${STATEMENT_TIMEOUT_MS}ms; task ${LOOP_HANG_TASK_ID} registered`,
  );

  try {
    /* -- seed a 'waiting' run whose resume the scanner will try to take ------ */
    // The run is 'waiting' with a 'duration' wait that is NOT yet due, and a
    // queue row with available_at in the future (the claim loop must not pick up
    // a waiting run on its own). The wait only becomes due AFTER the queue row's
    // FOR UPDATE lock is held below — so there is no window in which a tick can
    // legally complete the resume first and the lock grab is purely sequential.
    const runId = `loop-hang-${Date.now()}`;
    await s.pool.query(
      `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type)
       VALUES ($1, 'default', 'prod', $2, 'waiting', 'api')`,
      [runId, LOOP_HANG_TASK_ID],
    );
    await s.pool.query(
      `INSERT INTO queue (run_id, project_id, env, available_at)
       VALUES ($1, 'default', 'prod', now() + interval '1 hour')`,
      [runId],
    );
    await s.pool.query(
      `INSERT INTO waits (run_id, project_id, env, step_seq, kind, resume_at, status)
       VALUES ($1, 'default', 'prod', 0, 'duration', now() + interval '1 hour', 'pending')`,
      [runId],
    );
    s.log(`seeded run ${runId} as 'waiting' (due wait + queue row not yet visible)`);

    // The gauge only emits loops that have ticked at least once (loopLastSuccess
    // starts at 0). Let the waits loop complete a healthy tick BEFORE the lock
    // is held, so the freeze observation below starts from a real value rather
    // than the never-ticked 0.
    await waitFor(
      `waits loop to complete its first healthy tick`,
      10_000,
      async () => (await readWaitsLastSuccess(daemon.url!)) > 0,
      { intervalMs: 200 },
    );
    s.ok(`waits loop ticked once (loopLastSuccess{loop="waits"} present)`);

    /* -- hold the queue row's FOR UPDATE lock ---------------------------------- */
    const blocker = await s.pool.connect();
    let holding = false;
    const release = async (): Promise<void> => {
      if (!holding) return;
      holding = false;
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    };
    s.cleanup(release);

    await blocker.query('BEGIN');
    await blocker.query(
      `SELECT run_id FROM queue
        WHERE run_id = $1 AND project_id = 'default' AND env = 'prod'
        FOR UPDATE`,
      [runId],
    );
    holding = true;

    // Now the wait is due — the scanner's phase-1 read picks it up, and its
    // phase-2 position-1 statement blocks on OUR lock (it is the plain blocking
    // FOR UPDATE, not SKIP LOCKED).
    await s.pool.query(
      `UPDATE waits SET resume_at = now() - interval '1 minute'
        WHERE run_id = $1 AND project_id = 'default' AND env = 'prod'`,
      [runId],
    );
    s.log(`queue row FOR UPDATE held; wait is now due — scanWaits will block on it`);

    /* -- a. the blocked resume is cancelled, not a silent death ----------------- */
    // The tick blocks on the queue-row lock; statement_timeout cancels the
    // statement ~2s later; the loop's catch increments loopErrors.waits and the
    // next tick runs again. Without statement_timeout this counter would stay 0
    // and the loop would be dead — which is exactly the failure p1-11 closes.
    await waitFor(
      `better_trigger_orchestrator_errors_total{loop="waits"} to climb to 1`,
      20_000,
      async () => (await readWaitsErrors(daemon.url!)) >= 1,
      { intervalMs: 200 },
    );
    s.ok(`scanWaits' blocked resume was cancelled by statement_timeout (loopErrors.waits ≥ 1)`);

    /* -- c. the stall is visible on the gauge ----------------------------------- */
    // While the lock is held every tick keeps erroring, so the last-success
    // timestamp cannot advance — two scrapes a tick-interval apart read the same
    // value. That freeze is the gauge doing its job: a dead loop (no
    // statement_timeout) looks identical here, which is why the error counter
    // above is the discriminator.
    const frozen = await readWaitsLastSuccess(daemon.url!);
    await sleep(FROZEN_OBSERVE_MS);
    const stillFrozen = await readWaitsLastSuccess(daemon.url!);
    s.assert(
      stillFrozen === frozen,
      `loopLastSuccess{loop="waits"} stayed frozen at ${frozen} while the lock was held`,
    );
    s.ok(`the stall is visible: loopLastSuccess{loop="waits"} frozen at ${frozen}`);

    /* -- d. release → the loop self-heals and the run is no longer stuck -------- */
    await release();
    await waitFor(
      `waits loop to resume (loopLastSuccess{loop="waits"} > ${frozen})`,
      15_000,
      async () => (await readWaitsLastSuccess(daemon.url!)) > frozen,
      { intervalMs: 200 },
    );
    const resumed = await readWaitsLastSuccess(daemon.url!);
    await sleep(ADVANCE_OBSERVE_MS);
    const advanced = await readWaitsLastSuccess(daemon.url!);
    s.assert(
      advanced > resumed,
      `loopLastSuccess{loop="waits"} keeps advancing (${resumed} → ${advanced}) ` +
        `after the lock was released — the loop is alive, not dead`,
    );
    s.ok(`waits loop resumed: loopLastSuccess{loop="waits"} ${frozen} → ${resumed} → ${advanced}`);

    // The resume itself went through: the run left 'waiting', was claimed and
    // completed. 'completed' is the end-to-end proof; a resume that only half
    // ran would leave it 'queued' forever or 'waiting'.
    await waitFor(
      `run ${runId} to reach 'completed'`,
      20_000,
      async () => {
        const res = await s.pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [runId],
        );
        const status = res.rows[0]?.status;
        if (status === 'completed') return true;
        if (status === 'failed' || status === 'canceled') {
          // Terminal before completing — the resume ran but the run itself did
          // not finish; say so loudly rather than burn the timeout.
          return { abort: `run ended '${status}' instead of completing` };
        }
        return false;
      },
      { intervalMs: 200 },
    );
    s.ok(`run ${runId} resumed after the lock was released and completed`);
  } finally {
    // Always stop the daemon BEFORE the runner drops the db — teardown runs
    // LIFO, and a stop against an already-dropped database would turn the
    // handoff's release-claims / mark-offline steps into noise.
    await daemon.stop();
  }
}

void runScenario(
  {
    name: 'loop-hang',
    what: 'a blocked scanWaits resume is cancelled by statement_timeout and the loop self-heals (p1-11)',
    db: { name: 'better_trigger_loop_hang', envVar: 'BT_LOOP_HANG_DB' },
  },
  main,
);
