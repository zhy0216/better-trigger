/* =============================================================================
   @better-trigger/example-basic — fencing-token e2e (kernel-level).

   Two workers race over one run, straight against createKernel (no SDK
   executor): worker A claims with a tiny lease and never heartbeats; the
   reaper releases the expired claim; worker B reclaims and the fencing token
   increments by exactly 1. Every write A attempts with its stale token must
   be rejected with StaleLeaseError, while B's writes land normally.

   Fully self-contained: provisions its own database (better_trigger_fencing).

   Env:
     DATABASE_URL    base connection derived from it; default
                     postgres://localhost:5432/better_trigger
     BT_FENCING_DB   override the provisioned database name (default
                     better_trigger_fencing)
   ============================================================================= */
import { createKernel, StaleLeaseError } from '@better-trigger/core';
import { createPool, migrate } from '@better-trigger/db';

/* ---------------------------------------------------------------------------
 * Config + database provisioning
 * ------------------------------------------------------------------------- */
const RAW_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/better_trigger';
const FENCING_DB = process.env.BT_FENCING_DB ?? 'better_trigger_fencing';

function baseUrl(u: string): string {
  const url = new URL(u);
  url.pathname = '';
  return url.toString().replace(/\/+$/, '');
}

const BASE = baseUrl(RAW_URL);
const DB_URL = `${BASE}/${FENCING_DB}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}
function ok(msg: string): void {
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */
console.log(`\nbetter-trigger fencing e2e → ${DB_URL}\n`);

{
  const admin = createPool(`${BASE}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${FENCING_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${FENCING_DB}`);
  await admin.end();
}

const pool = createPool(DB_URL);
await migrate(pool);
const kernel = createKernel({ pool });

/* -- two workers, one task, one run ---------------------------------------- */
const manifest = [{ id: 'fenced-task', retry: { maxAttempts: 3 } }];
const { workerId: workerA } = await kernel.registerWorker({
  name: 'fencing-a',
  codeVersion: 'v1',
  runtime: 'bun',
  concurrency: 1,
  tasks: manifest,
});
const { workerId: workerB } = await kernel.registerWorker({
  name: 'fencing-b',
  codeVersion: 'v1',
  runtime: 'bun',
  concurrency: 1,
  tasks: manifest,
});
ok(`registered workers A=${workerA} B=${workerB}`);

const { runId } = await kernel.trigger({ taskId: 'fenced-task', payload: { n: 1 } });

/* -- A claims with a tiny lease and goes silent (no heartbeat) ------------- */
const [claimA] = await kernel.claimRuns({
  workerId: workerA,
  taskIds: ['fenced-task'],
  limit: 1,
  leaseMs: 300,
});
assert(claimA && claimA.id === runId, 'worker A should claim the run');
const tokenA = claimA.fencingToken;
ok(`A claimed with fencing token ${tokenA} (lease 300ms, never renewed)`);

/* -- reaper releases the expired lease ------------------------------------- */
const orch = kernel.startOrchestrator({ reaperIntervalMs: 500 });
await sleep(1_500); // lease long expired; reaper has run several times

const reaped = await kernel.getRun(runId);
assert(
  reaped.status === 'queued' && reaped.attempt === 2,
  `reaper should requeue the run as attempt 2, got status='${reaped.status}' attempt=${reaped.attempt}`,
);
ok('reaper released the zombie claim (run requeued, attempt 2)');

/* -- B reclaims: token must increment by exactly 1 -------------------------- */
const [claimB] = await kernel.claimRuns({
  workerId: workerB,
  taskIds: ['fenced-task'],
  limit: 1,
  leaseMs: 60_000,
});
assert(claimB && claimB.id === runId, 'worker B should reclaim the run');
assert(
  claimB.fencingToken === tokenA + 1,
  `reclaim should bump the token by 1 (${tokenA} → ${tokenA + 1}), got ${claimB.fencingToken}`,
);
ok(`B reclaimed with fencing token ${claimB.fencingToken} (= A.token + 1)`);

/* -- A's stale-token writes are rejected ------------------------------------ */
const nowIso = () => new Date().toISOString();

try {
  await kernel.reportStep({
    runId,
    seq: 1,
    kind: 'step',
    label: 'zombie-step',
    status: 'completed',
    output: 'from-A',
    attempt: 1,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    workerId: workerA,
    fencingToken: tokenA,
  });
  fail('stale reportStep from A should have thrown');
} catch (err) {
  assert(err instanceof StaleLeaseError, `expected StaleLeaseError, got ${String(err)}`);
  ok('A reportStep with stale token → StaleLeaseError');
}

try {
  await kernel.completeRun({ runId, output: 'from-A', workerId: workerA, fencingToken: tokenA });
  fail('stale completeRun from A should have thrown');
} catch (err) {
  assert(err instanceof StaleLeaseError, `expected StaleLeaseError, got ${String(err)}`);
  ok('A completeRun with stale token → StaleLeaseError');
}

/* -- B's writes land normally ----------------------------------------------- */
await kernel.reportStep({
  runId,
  seq: 1,
  kind: 'step',
  label: 'real-step',
  status: 'completed',
  output: 'from-B',
  attempt: 2,
  startedAt: nowIso(),
  finishedAt: nowIso(),
  workerId: workerB,
  fencingToken: claimB.fencingToken,
});
await kernel.completeRun({
  runId,
  output: 'done-by-B',
  workerId: workerB,
  fencingToken: claimB.fencingToken,
});
ok('B reportStep + completeRun accepted under the current token');

/* -- final state ------------------------------------------------------------ */
const detail = await kernel.getRunDetail(runId);
assert(detail.run.status === 'completed', `run should be completed, got '${detail.run.status}'`);
assert(detail.run.output === 'done-by-B', `output should be B's, got ${JSON.stringify(detail.run.output)}`);
assert(
  detail.steps.length === 1 && detail.steps[0].label === 'real-step' && detail.steps[0].output === 'from-B',
  `expected exactly 1 step row (B's), got ${JSON.stringify(detail.steps)}`,
);
assert(detail.run.attempt === 2, `attempt should be 2, got ${detail.run.attempt}`);
ok('run completed with a single step row (B) and attempt = 2');

/* -- teardown --------------------------------------------------------------- */
orch.stop();
await pool.end();
{
  const admin = createPool(`${BASE}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${FENCING_DB} WITH (FORCE)`);
  await admin.end();
}

console.log(`\nAll ${passed} fencing checks passed.\n`);
process.exit(0);
