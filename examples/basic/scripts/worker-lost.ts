/* =============================================================================
   @better-trigger/example-basic — worker-lost e2e (reaper terminalFail +
   parent wakeup).

   Pins the reaper's terminal-failure path: when a worker dies holding a child
   that has NO retry budget left, the child must be failed as 'worker lost'
   AND its waiting parent must be woken (not left 'waiting' forever).

   Two daemons: an API node (no --tasks) that serves the harness's client and
   keeps a reaper alive, plus an executor node (--tasks worker-lost-tasks.ts
   --no-serve) that gets killed.

   Flow: spawn the executor → trigger wl-parent (which triggerAndWaits
   wl-child, retry { maxAttempts: 1 }) → SIGKILL the executor while the child
   is 'running' (parent 'waiting') → restart an executor. A reaper (500ms,
   lease 3s) finds the child's expired lease at max attempts → terminalFail:
   child 'failed' with error 'worker lost', parent re-queued. The new executor
   replays the parent; the cached trigger-and-wait step yields ok:false and the
   parent completes.

   Asserts:
     - child ends 'failed' with error.message 'worker lost', attempt still 1
     - parent ends 'completed' with output.ok === false + the child's error
     - parent carries exactly 1 completed 'trigger-and-wait' step

   Env:
     DATABASE_URL       base connection derived from it; default
                        postgres://localhost:5432/better_trigger
     BT_WORKER_LOST_DB  override the provisioned database name (default
                        better_trigger_worker_lost)
     BT_WORKER_LOST_PORT  port the API node listens on (default 4904)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@better-trigger/db';
import { betterTrigger } from 'better-trigger';
import { spawnDaemon, startDaemon, type Daemon } from './daemon';

/* ---------------------------------------------------------------------------
 * Config + database provisioning
 * ------------------------------------------------------------------------- */
const RAW_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/better_trigger';
const WL_DB = process.env.BT_WORKER_LOST_DB ?? 'better_trigger_worker_lost';

function baseUrl(u: string): string {
  const url = new URL(u);
  url.pathname = '';
  return url.toString().replace(/\/+$/, '');
}

const BASE = baseUrl(RAW_URL);
const DB_URL = `${BASE}/${WL_DB}`;
const PORT = Number(process.env.BT_WORKER_LOST_PORT ?? 4904);

const tasksModule = fileURLToPath(new URL('./worker-lost-tasks.ts', import.meta.url));

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
    concurrency: 2,
    leaseMs: 3_000,
    reaperIntervalMs: 500,
  });
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
console.log(`\nbetter-trigger worker-lost e2e → ${DB_URL}\n`);

{
  const admin = createPool(`${BASE}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${WL_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${WL_DB}`);
  await admin.end();
}

// Migrate up front so the daemons never race on migrations.
const pool = createPool(DB_URL);
await migrate(pool);

// The API node: serves the client and keeps a reaper alive across the kill.
const api = await startDaemon({
  databaseUrl: DB_URL,
  port: PORT,
  reaperIntervalMs: 500,
});
const client = betterTrigger({ url: api.url! });

/* -- boot executor #1 and trigger the parent ------------------------------- */
let proc = spawnExecutor();

await waitFor('wl-parent + wl-child registered', 30_000, async () => {
  try {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE id IN ('wl-parent', 'wl-child')`,
    );
    return res.rows[0].n === 2;
  } catch {
    return false;
  }
});
ok(`executor #1 up, wl-parent + wl-child registered`);

const handle = await client.trigger('wl-parent', { note: 'lose-the-worker' });
console.log(`  parent run: ${handle.id}`);

/* -- SIGKILL while the child is running ------------------------------------ */
// The child only exists once the parent's triggerAndWait committed (child +
// pending 'run' wait + parent suspended, atomically) — so child 'running'
// implies the parent is already 'waiting'.
let childRunId = '';
await waitFor(`wl-child run 'running'`, 30_000, async () => {
  const res = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM runs WHERE task_id = 'wl-child'`,
  );
  const row = res.rows[0];
  if (!row) return false;
  childRunId = row.id;
  return row.status === 'running';
});
const parentAtKill = await client.getRun(handle.id);
assert(
  parentAtKill.status === 'waiting',
  `parent should be 'waiting' at kill time, got '${parentAtKill.status}'`,
);
await proc.kill();
ok(`SIGKILL while child ${childRunId} is 'running' (parent 'waiting')`);

/* -- restart: reaper terminal-fails the child, parent wakes + completes ----- */
proc = spawnExecutor();
const result = await client.waitForResult(handle.id, { timeoutMs: 60_000 });

assert(result.status === 'completed', `parent should complete, got '${result.status}'`);
ok('parent completed after the worker was lost');

const out = result.output as {
  ok: boolean;
  childRunId: string;
  error: { message?: string } | null;
};
assert(out.ok === false, `parent output.ok should be false, got ${JSON.stringify(out.ok)}`);
assert(
  out.childRunId === childRunId,
  `parent output.childRunId should be ${childRunId}, got ${out.childRunId}`,
);
assert(
  !!out.error && typeof out.error.message === 'string' && out.error.message.includes('worker lost'),
  `parent output.error should carry 'worker lost', got ${JSON.stringify(out.error)}`,
);
ok(`parent output: ok=false with the child's 'worker lost' error`);

const child = await client.getRunDetail(childRunId);
assert(child.run.status === 'failed', `child should be 'failed', got '${child.run.status}'`);
assert(
  child.run.error?.message === 'worker lost',
  `child error should be 'worker lost', got ${JSON.stringify(child.run.error)}`,
);
assert(
  child.run.attempt === 1,
  `child (maxAttempts 1) must never be retried, got attempt ${child.run.attempt}`,
);
ok(`child failed as 'worker lost' at attempt 1 (no retry)`);

const parentDetail = await client.getRunDetail(handle.id);
const taw = parentDetail.steps.filter(
  (s) => s.kind === 'trigger-and-wait' && s.status === 'completed',
);
assert(taw.length === 1, `expected 1 completed 'trigger-and-wait' step, got ${taw.length}`);
ok(`parent has exactly 1 completed 'trigger-and-wait' step`);

/* -- teardown -------------------------------------------------------------- */
await proc.stop(); // graceful: drain + stop loops
await api.stop();
await pool.end();

console.log(`\nAll ${passed} worker-lost checks passed.\n`);
process.exit(0);
