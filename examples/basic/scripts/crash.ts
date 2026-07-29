/* =============================================================================
   @better-trigger/example-basic — crash-recovery e2e (lease/fencing/reaper).

   Fully self-contained: provisions its own database (better_trigger_crash) and
   runs two daemons —

     · an API node (no --tasks) that serves HTTP and runs the lease reaper. It
       survives every kill, so the harness's client keeps answering and leases
       still get reaped while no executor is alive.
     · an executor node (--tasks crash-tasks.ts --no-serve) that claims and
       runs. This is the one that gets SIGKILLed.

   The executor is SIGKILLed at three points:

     ① after "step1" hits the marker file (mid pure-sleep, run 'running')
     ② after the run is observed 'waiting'  (suspended on wait.for("2s"))
     ③ after a restart brings the run back to 'running' (post-resume sleep)

   After every kill a fresh executor is spawned; a reaper (500ms) must release
   the expired lease (3s) so the new executor can reclaim under a bumped
   fencing token. Final assertions prove exactly-once durable steps:

     - run completed, output echoes the payload
     - marker file has exactly 1 "step1" line and exactly 1 "step2" line
     - step ledger is exactly [step, wait, step]
     - attempt >= 3 (one bump per reaped kill; the 'waiting' kill costs none)

   Mid-flight (while 'waiting', before kill-②) it also asserts that kill-①
   recovery cost exactly one attempt bump (attempt === 2) and that the suspend
   released the claim (zero queue rows for the run).

   Env:
     DATABASE_URL  base connection derived from it; default
                   postgres://localhost:5432/better_trigger
     BT_CRASH_DB   override the provisioned database name (default
                   better_trigger_crash)
     BT_CRASH_PORT port the API node listens on (default 4902)
   ============================================================================= */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@better-trigger/db';
import { betterTrigger, type RunStatus } from 'better-trigger';
import { spawnDaemon, startDaemon, type Daemon } from './daemon';

/* ---------------------------------------------------------------------------
 * Config + database provisioning
 * ------------------------------------------------------------------------- */
const RAW_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/better_trigger';
const CRASH_DB = process.env.BT_CRASH_DB ?? 'better_trigger_crash';

function baseUrl(u: string): string {
  const url = new URL(u);
  url.pathname = '';
  return url.toString().replace(/\/+$/, '');
}

const BASE = baseUrl(RAW_URL);
const DB_URL = `${BASE}/${CRASH_DB}`;
const PORT = Number(process.env.BT_CRASH_PORT ?? 4902);

const tasksModule = fileURLToPath(new URL('./crash-tasks.ts', import.meta.url));
const markerFile = join(mkdtempSync(join(tmpdir(), 'bt-crash-')), 'marker.txt');
writeFileSync(markerFile, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

let passed = 0;
function ok(msg: string): void {
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

/* ---------------------------------------------------------------------------
 * Executor node control (short lease + fast reaper keep recovery quick)
 * ------------------------------------------------------------------------- */
function spawnExecutor(): Daemon {
  return spawnDaemon({
    databaseUrl: DB_URL,
    tasks: tasksModule,
    serve: false,
    concurrency: 1,
    leaseMs: 3_000,
    reaperIntervalMs: 500,
    env: { BT_MARKER_FILE: markerFile },
  });
}

/* ---------------------------------------------------------------------------
 * Polling helpers
 * ------------------------------------------------------------------------- */
function markerLines(name: string): number {
  return readFileSync(markerFile, 'utf8')
    .split('\n')
    .filter((l) => l === name).length;
}

async function waitFor(label: string, timeoutMs: number, cond: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(100);
  }
  fail(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */
console.log(`\nbetter-trigger crash-recovery e2e → ${DB_URL}\n`);

{
  const admin = createPool(`${BASE}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${CRASH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${CRASH_DB}`);
  await admin.end();
}

// Migrate up front so the daemons never race on migrations.
const pool = createPool(DB_URL);
await migrate(pool);

// The API node: serves the client and keeps a reaper alive across every kill.
const api = await startDaemon({
  databaseUrl: DB_URL,
  port: PORT,
  reaperIntervalMs: 500,
});
const client = betterTrigger({ url: api.url! });

const runStatus = async (runId: string): Promise<RunStatus> => (await client.getRun(runId)).status;

/* -- boot executor #1 and trigger the run --------------------------------- */
let proc = spawnExecutor();

await waitFor('crash-test task registered', 30_000, async () => {
  try {
    const res = await pool.query(`SELECT 1 FROM tasks WHERE id = 'crash-test'`);
    return res.rows.length === 1;
  } catch {
    return false;
  }
});
ok('executor #1 up, crash-test registered');

const payload = { note: 'survive-the-crash' };
const handle = await client.trigger('crash-test', payload);
console.log(`  run: ${handle.id}`);

/* -- kill point ① : mid-sleep after step1 --------------------------------- */
await waitFor('"step1" marker line (durable step committed)', 30_000, async () =>
  markerLines('step1') >= 1,
);
await sleep(1_000); // stay inside the 4s sleep window, past the step commit
await proc.kill();
ok('kill ① — SIGKILL during post-step1 sleep (run running, lease held)');

/* -- executor #2: reclaim after reap, run to 'waiting', kill ② -------------- */
proc = spawnExecutor();
await waitFor(`run 'waiting' (suspended on wait.for)`, 60_000, async () =>
  (await runStatus(handle.id)) === 'waiting',
);

// Kill-① recovery must have cost exactly ONE attempt bump: reap → attempt 2,
// reclaim + replay by executor #2 (no further bumps up to the suspend).
{
  const mid = await client.getRunDetail(handle.id);
  assert(
    mid.run.attempt === 2,
    `attempt should be exactly 2 after kill-① reap+reclaim, got ${mid.run.attempt}`,
  );
  ok('kill-① recovery cost exactly one attempt bump (attempt = 2)');

  // Suspend must have released the claim: no queue row while 'waiting'.
  const q = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM queue WHERE run_id = $1`,
    [handle.id],
  );
  assert(
    q.rows[0].n === '0',
    `expected 0 queue rows while 'waiting' (suspend releases the claim), got ${q.rows[0].n}`,
  );
  ok(`no queue row while 'waiting' (suspend released the claim)`);
}

await proc.kill();
ok(`kill ② — SIGKILL while run is 'waiting' (worker held no claim)`);

/* -- executor #3: resume the wait, back to 'running', kill ③ ---------------- */
proc = spawnExecutor();
await waitFor(`run back to 'running' after resume`, 60_000, async () =>
  (await runStatus(handle.id)) === 'running',
);
await proc.kill();
ok(`kill ③ — SIGKILL during post-resume sleep (run running again)`);

/* -- executor #4: reclaim and finish ---------------------------------------- */
proc = spawnExecutor();
const result = await client.waitForResult(handle.id, { timeoutMs: 60_000 });

/* -- final assertions ------------------------------------------------------ */
assert(result.status === 'completed', `run should complete, got '${result.status}'`);
ok('run completed after 3 kills');

assert(
  JSON.stringify(result.output) === JSON.stringify(payload),
  `output should echo the payload, got ${JSON.stringify(result.output)}`,
);
ok('output echoes the payload');

const step1Lines = markerLines('step1');
const step2Lines = markerLines('step2');
assert(step1Lines === 1, `marker should have exactly 1 "step1" line, got ${step1Lines}`);
assert(step2Lines === 1, `marker should have exactly 1 "step2" line, got ${step2Lines}`);
ok('marker file: step1 ×1, step2 ×1 (durable steps ran exactly once)');

const detail = await client.getRunDetail(handle.id);
const kinds = detail.steps.map((s) => s.kind);
assert(
  JSON.stringify(kinds) === JSON.stringify(['step', 'wait', 'step']),
  `step ledger should be [step, wait, step], got [${kinds.join(', ')}]`,
);
ok('step ledger is exactly [step, wait, step]');

assert(
  detail.run.attempt >= 3,
  `attempt should be >= 3 after two reaped kills, got ${detail.run.attempt}`,
);
ok(`attempt = ${detail.run.attempt} (>= 3)`);

/* -- teardown -------------------------------------------------------------- */
await proc.stop(); // graceful: drain + stop loops
await api.stop();
await pool.end();

console.log(`\nAll ${passed} crash-recovery checks passed.\n`);
process.exit(0);
