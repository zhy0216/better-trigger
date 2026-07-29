/* =============================================================================
   @better-trigger/example-basic — replay-drift acceptance harness.

   Proves the three guardrails against a mid-flight redeploy — the scenario a
   long ctx.wait makes routine, because a suspended run's ledger can outlive
   several deploys:

     ① runs.code_version is stamped at trigger time, so "which code shape was
        this run's ledger written against?" is answerable after the fact.
     ② the worker's code version fingerprints each run() body, so editing a task
        changes the version even though ids and cron are untouched. (Under the
        old id+cron-only signature both deploys below hash identically.)
     ③ replay:'strict' fails a run whose ledger no longer matches its call
        sites, instead of feeding it a foreign step row.

   Shape: an API node (no --tasks) serves HTTP and runs the orchestrator across
   the whole test, while executor nodes are swapped under it:

     deploy #1 (replay-drift-tasks-v1.ts) → both runs suspend on the wait → kill
     deploy #2 (replay-drift-tasks-v2.ts) → resumes the waits, then replays them
                                            against a run() with a step inserted
                                            at seq 1, where v1's ledger holds
                                            the wait row

   (The API node registers no tasks, so it runs bookkeeping only — waits/cron
   stay off. With no executor alive the runs stay suspended, which is what lets
   the harness swap deploys deterministically.)

   Then the two strictness modes are contrasted on identical ledgers:
     drift-strict  → fails with AbortError, attempt stays 1 (no retry storm)
     drift-lenient → COMPLETES, reporting success for a step whose body never
                     ran. That silent corruption is the thing 'strict' buys out.

   Env:
     DATABASE_URL   base connection derived from it; default
                    postgres://localhost:5432/better_trigger
     BT_DRIFT_DB    provisioned database name (default better_trigger_drift)
     BT_DRIFT_PORT  port the API node listens on (default 4903)
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
const DRIFT_DB = process.env.BT_DRIFT_DB ?? 'better_trigger_drift';

function baseUrl(u: string): string {
  const url = new URL(u);
  url.pathname = '';
  return url.toString().replace(/\/+$/, '');
}

const BASE = baseUrl(RAW_URL);
const DB_URL = `${BASE}/${DRIFT_DB}`;
const PORT = Number(process.env.BT_DRIFT_PORT ?? 4903);

const V1_MODULE = fileURLToPath(new URL('./replay-drift-tasks-v1.ts', import.meta.url));
const V2_MODULE = fileURLToPath(new URL('./replay-drift-tasks-v2.ts', import.meta.url));

/** Long enough to observe 'waiting' and kill deploy #1 before it resumes. */
const WAIT_FOR = '6s';

const markerFile = join(mkdtempSync(join(tmpdir(), 'bt-drift-')), 'marker.txt');
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

function markerLines(name: string): number {
  return readFileSync(markerFile, 'utf8')
    .split('\n')
    .filter((l) => l === name).length;
}

async function waitFor(
  label: string,
  timeoutMs: number,
  cond: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(100);
  }
  fail(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function spawnExecutor(tasksModule: string, label: string): Daemon {
  return spawnDaemon({
    databaseUrl: DB_URL,
    tasks: tasksModule,
    serve: false,
    concurrency: 2,
    name: label,
    env: { BT_MARKER_FILE: markerFile, BT_DRIFT_WAIT: WAIT_FOR },
  });
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */
console.log(`\nbetter-trigger replay-drift acceptance → ${DB_URL}\n`);

{
  const admin = createPool(`${BASE}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${DRIFT_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DRIFT_DB}`);
  await admin.end();
}

const pool = createPool(DB_URL);
await migrate(pool);

// API node: HTTP + orchestrator. Registers no tasks, so it never touches
// tasks.latest_code_version — the executors alone move that.
const api = await startDaemon({ databaseUrl: DB_URL, port: PORT, reaperIntervalMs: 500 });
const client = betterTrigger({ url: api.url! });

const runStatus = async (id: string): Promise<RunStatus> => (await client.getRun(id)).status;

async function latestCodeVersion(taskId: string): Promise<string | null> {
  const res = await pool.query<{ v: string | null }>(
    `SELECT latest_code_version AS v FROM tasks WHERE id = $1`,
    [taskId],
  );
  return res.rows[0]?.v ?? null;
}

/* -- deploy #1: trigger both runs and let them suspend --------------------- */
let executor = spawnExecutor(V1_MODULE, 'deploy-v1');

await waitFor('deploy #1 registered both tasks', 30_000, async () => {
  try {
    const res = await pool.query(
      `SELECT 1 FROM tasks WHERE id IN ('drift-strict','drift-lenient')`,
    );
    return res.rows.length === 2;
  } catch {
    return false;
  }
});
const V1 = await latestCodeVersion('drift-strict');
assert(V1 !== null, 'deploy #1 should have registered a code version');
ok(`deploy #1 up — code version ${V1}`);

const strictRun = await client.trigger('drift-strict', { user: 'u_42' });
const lenientRun = await client.trigger('drift-lenient', { user: 'u_42' });
console.log(`  strict run:  ${strictRun.id}\n  lenient run: ${lenientRun.id}`);

await waitFor(`both runs 'waiting' on the wait`, 30_000, async () =>
  (await runStatus(strictRun.id)) === 'waiting' &&
  (await runStatus(lenientRun.id)) === 'waiting',
);
ok(`both runs suspended on ctx.wait.for("${WAIT_FOR}")`);

/* -- ① code_version is stamped on the run at trigger time ------------------ */
{
  const strict = await client.getRun(strictRun.id);
  const lenient = await client.getRun(lenientRun.id);
  assert(
    strict.codeVersion === V1 && lenient.codeVersion === V1,
    `runs.code_version should be stamped '${V1}' at trigger time, got ` +
      `'${strict.codeVersion}' / '${lenient.codeVersion}'`,
  );
  ok(`① runs.code_version stamped at trigger time (${V1})`);
}

await executor.kill();
ok('deploy #1 killed while both runs were waiting');

// The API node is bookkeeping-only ({ waits: false, cron: false } — main.ts),
// so with no executor alive nothing resumes the waits: the runs stay suspended
// past their resume_at, and deploy #2 is what both wakes and replays them.
await sleep(9_000); // > WAIT_FOR, so resume_at is comfortably in the past
{
  const strict = await runStatus(strictRun.id);
  const lenient = await runStatus(lenientRun.id);
  assert(
    strict === 'waiting' && lenient === 'waiting',
    `with no executor alive both runs should still be 'waiting', got '${strict}' / '${lenient}'`,
  );
  ok(`both runs still 'waiting' past resume_at (API node resumes nothing)`);
}

/* -- deploy #2: same ids, one inserted step -------------------------------- */
executor = spawnExecutor(V2_MODULE, 'deploy-v2');

await waitFor('deploy #2 registered a new code version', 30_000, async () => {
  const v = await latestCodeVersion('drift-strict');
  return v !== null && v !== V1;
});
const V2 = await latestCodeVersion('drift-strict');
ok(`② code version changed on a body-only edit: ${V1} → ${V2}`);
ok('   (task ids and cron are byte-identical across the two deploys)');

/* -- ③ strict: the drift is refused --------------------------------------- */
{
  const result = await client.waitForResult(strictRun.id, { timeoutMs: 60_000 });
  assert(
    result.status === 'failed',
    `strict run should fail on drift, got '${result.status}'`,
  );
  ok(`③ replay:'strict' failed the run instead of replaying a foreign step row`);

  assert(
    result.error?.name === 'AbortError',
    `drift failure should be an AbortError (non-retryable), got '${result.error?.name}'`,
  );
  const message = result.error?.message ?? '';
  assert(
    message.includes('replay drift at seq 1'),
    `error should name the drifting seq, got: ${message}`,
  );
  assert(
    message.includes(`kind 'wait' → 'step'`),
    `error should name the kind mismatch, got: ${message}`,
  );
  ok(`   error pinpoints the position: "replay drift at seq 1: kind 'wait' → 'step'"`);

  const detail = await client.getRunDetail(strictRun.id);
  assert(
    detail.run.attempt === 1,
    `an aborted drift must not retry; attempt should be 1, got ${detail.run.attempt}`,
  );
  ok('   no retry storm — attempt stayed 1 (AbortError is terminal)');

  assert(
    detail.run.codeVersion === V1,
    `the failed run should still carry its trigger-time version '${V1}', got '${detail.run.codeVersion}'`,
  );
  ok(`   post-mortem is answerable: run stamped ${V1}, executed by ${V2}`);
}

/* -- lenient: the same ledger silently corrupts ---------------------------- */
{
  const result = await client.waitForResult(lenientRun.id, { timeoutMs: 60_000 });
  assert(
    result.status === 'completed',
    `lenient run is expected to COMPLETE (that is the hazard), got '${result.status}'`,
  );
  ok('lenient replay completed the run — reporting success, as before');

  const audits = markerLines('audit:lenient');
  assert(
    audits === 0,
    `the inserted step's body must never have run under lenient replay, got ${audits} marker lines`,
  );
  // The wait row stores SQL NULL, which the snapshot maps back to `undefined`
  // (StepSnapshot.output = s.output ?? undefined) — so the caller does not even
  // get a null it could null-check; the key vanishes from the output entirely.
  const output = result.output as Record<string, unknown> | null;
  assert(
    output !== null && !('audit' in output),
    `the inserted step should have returned the wait row's empty output, got ${JSON.stringify(output?.audit)}`,
  );
  ok(`   …but step "audit" never executed and yielded the wait row's undefined`);

  const detail = await client.getRunDetail(lenientRun.id);
  const warned = detail.logs.some(
    (l) => l.level === 'warn' && l.message.includes('replay drift at seq 1'),
  );
  assert(warned, 'lenient replay should at least warn about the drift');
  ok('   the only trace is a warn log — exactly what strict mode upgrades');

  assert(
    markerLines('load:lenient') === 1,
    'the agreeing prefix should still replay from cache exactly once',
  );
  ok('   the agreeing prefix (seq 0) still replayed from cache exactly once');
}

/* -- teardown -------------------------------------------------------------- */
await executor.stop();
await api.stop();
await pool.end();

console.log(`\nAll ${passed} replay-drift checks passed.\n`);
process.exit(0);
