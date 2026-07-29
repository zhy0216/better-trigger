/* =============================================================================
   @better-trigger/example-basic — end-to-end smoke test.

   Fully self-contained. The script provisions its own database (DROP/CREATE
   better_trigger_e2e against the <base>/postgres admin db), spawns a worker
   daemon over src/tasks.ts, and runs every check through the HTTP client —
   exactly the path an application takes:
     - trigger.trigger / handle.result   (enqueue + await runs)
     - trigger.getRunDetail / getRun     (poll runs; .steps asserts the ledger)
     - direct SQL on tasks / schedules   (registration + cron assertions)

   Each check prints ✓/✗ with its elapsed time; a final summary follows.
   Any failed assertion makes the process exit(1).

   Env:
     DATABASE_URL  base connection is derived from it (db name is replaced);
                   default postgres://localhost:5432/better_trigger
     BT_E2E_DB     override the provisioned database name (default
                   better_trigger_e2e)
     BT_E2E_PORT   port the daemon listens on (default 4901)
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import { createPool } from '@better-trigger/db';
import {
  betterTrigger,
  type RunDetailResult,
  type RunStatus,
  type TriggerOptions,
} from 'better-trigger';
import { startDaemon } from './daemon';

/* ---------------------------------------------------------------------------
 * Config + database provisioning
 * ------------------------------------------------------------------------- */
const RAW_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/better_trigger';
const E2E_DB = process.env.BT_E2E_DB ?? 'better_trigger_e2e';
const PORT = Number(process.env.BT_E2E_PORT ?? 4901);
const TASKS_MODULE = fileURLToPath(new URL('../src/tasks.ts', import.meta.url));

/** Strip the database path off a postgres URL → protocol://user@host:port */
function baseUrl(u: string): string {
  const url = new URL(u);
  url.pathname = '';
  return url.toString().replace(/\/+$/, '');
}

const BASE = baseUrl(RAW_URL);
const DB_URL = `${BASE}/${E2E_DB}`;

const TERMINAL: RunStatus[] = ['completed', 'failed', 'canceled'];
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;

/* ---------------------------------------------------------------------------
 * Tiny assertion + reporting harness
 * ------------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const failures: string[] = [];

/** Run a named async check; record ✓/✗ with elapsed ms. */
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    passed += 1;
    console.log(`  ✓ ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - t0;
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name} (${ms}ms)\n      ${msg}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
 * Provision the e2e database, then boot the worker daemon
 * ------------------------------------------------------------------------- */
{
  const admin = createPool(`${BASE}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${E2E_DB}`);
  await admin.end();
}

// One daemon: it migrates, loads src/tasks.ts, executes, and serves the API.
const daemon = await startDaemon({
  databaseUrl: DB_URL,
  port: PORT,
  tasks: TASKS_MODULE,
  concurrency: 5,
  migrate: true,
});

/** The client under test — HTTP only, exactly what an app would hold. */
const trigger = betterTrigger({ url: daemon.url! });

/** Raw pool for assertions with no client API (tasks / schedules tables). */
const pool = createPool(DB_URL);

/* ---------------------------------------------------------------------------
 * Trigger + poll helpers
 * ------------------------------------------------------------------------- */
interface PollResult {
  detail: RunDetailResult;
  /** Every distinct status observed while polling (incl. transient 'waiting'). */
  observed: Set<RunStatus>;
}

/**
 * Poll a run until it reaches a terminal state. Returns the final detail plus
 * the set of statuses observed along the way (used to catch transient
 * `waiting`).
 */
async function pollRun(
  runId: string,
  opts: { timeoutMs?: number } = {},
): Promise<PollResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const observed = new Set<RunStatus>();
  let last: RunDetailResult | undefined;

  while (Date.now() < deadline) {
    last = await trigger.getRunDetail(runId);
    observed.add(last.run.status);
    if (TERMINAL.includes(last.run.status)) {
      return { detail: last, observed };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const got = last ? last.run.status : 'unknown';
  throw new Error(`run ${runId} did not settle within ${timeoutMs}ms (last status: ${got})`);
}

/** Trigger then poll to terminal; assert the terminal status matches. */
async function triggerAndPoll(
  taskId: string,
  payload: unknown,
  opts: { expectStatus?: RunStatus; timeoutMs?: number; options?: TriggerOptions } = {},
): Promise<PollResult> {
  const handle = await trigger.trigger(taskId, payload, opts.options);
  const res = await pollRun(handle.id, { timeoutMs: opts.timeoutMs });
  if (opts.expectStatus) {
    assertEqual(res.detail.run.status, opts.expectStatus, `${taskId} run status`);
  }
  return res;
}

/* ---------------------------------------------------------------------------
 * Checks
 * ------------------------------------------------------------------------- */

async function checkReady(): Promise<void> {
  await check('daemon is ready (health + migrated db + worker registered)', async () => {
    const health = await trigger.health();
    assert(health.ok === true, 'GET /health must report ok');

    const h = await pool.query('SELECT 1 AS ok');
    assert(h.rows[0]?.ok === 1, 'database must answer SELECT 1');

    const w = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM workers WHERE status = 'online'`,
    );
    assert(w.rows.length === 1, `expected 1 online worker row, got ${w.rows.length}`);
  });
}

async function checkTasksRegistered(): Promise<void> {
  await check('tasks table contains every example task', async () => {
    const res = await pool.query<{ id: string }>('SELECT id FROM tasks');
    const ids = new Set(res.rows.map((t) => t.id));
    const expected = [
      'hello-world',
      'order-pipeline',
      'onboarding-wait',
      'extract-audio',
      'video-pipeline',
      'fan-out',
      'flaky-task',
      'always-aborts',
      'parallel-steps',
      'every-minute',
      'every-2s',
    ];
    for (const id of expected) {
      assert(ids.has(id), `task "${id}" missing from tasks (worker not registered?)`);
    }
  });
}

async function checkHelloWorld(): Promise<void> {
  await check('hello-world completes with correct output', async () => {
    const { detail } = await triggerAndPoll(
      'hello-world',
      { name: 'ada' },
      { expectStatus: 'completed' },
    );
    assertEqual(detail.run.output, 'hi ada', 'hello-world output');
  });
}

async function checkOrderPipeline(): Promise<void> {
  await check('order-pipeline completes with the expected step ledger', async () => {
    const { detail } = await triggerAndPoll(
      'order-pipeline',
      { customer: 'ada', items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] },
      { expectStatus: 'completed' },
    );

    const steps = detail.steps;
    const byKind = (k: string) => steps.filter((s) => s.kind === k);

    // 3 user steps recorded exactly. The deterministic substitutes (uuid/now)
    // are reported asynchronously (contract §3.8), so assert >= 1 rather than
    // an exact count to stay race-free.
    const userSteps = byKind('step');
    assert(userSteps.length === 3, `expected 3 'step' rows, got ${userSteps.length}`);
    assert(byKind('uuid').length >= 1, `expected a 'uuid' row, got ${byKind('uuid').length}`);
    assert(byKind('now').length >= 1, `expected a 'now' row, got ${byKind('now').length}`);

    const labels = userSteps.map((s) => s.label).sort();
    assertEqual(
      labels,
      ['charge-card', 'create-shipment', 'validate-order'],
      'order-pipeline step labels',
    );

    // every recorded step must be completed.
    for (const s of steps) {
      assert(s.status === 'completed', `step seq ${s.seq} (${s.kind}) not completed`);
    }

    const out = detail.run.output as { itemCount: number; orderId: string };
    assert(out.itemCount === 3, `expected itemCount 3, got ${out.itemCount}`);
    assert(typeof out.orderId === 'string' && out.orderId.length > 0, 'orderId should be a uuid');
  });
}

async function checkOnboardingWait(): Promise<void> {
  await check('onboarding-wait suspends (waiting) then resumes; total >= 3s', async () => {
    const t0 = Date.now();
    const handle = await trigger.trigger('onboarding-wait', { userId: 'u-wait' });
    const res = await pollRun(handle.id, { timeoutMs: DEFAULT_TIMEOUT_MS });
    const elapsed = Date.now() - t0;

    assert(res.observed.has('waiting'), 'never observed a `waiting` status while polling');
    assertEqual(res.detail.run.status, 'completed', 'onboarding-wait final status');
    assert(elapsed >= 3_000, `expected >= 3000ms total, got ${elapsed}ms`);

    // The wait should be recorded as a completed step (kind 'wait').
    const waitSteps = res.detail.steps.filter((s) => s.kind === 'wait');
    assert(waitSteps.length === 1, `expected 1 'wait' step row, got ${waitSteps.length}`);

    const out = res.detail.run.output as { tipsSentTo: string };
    assertEqual(out.tipsSentTo, 'u-wait', 'onboarding-wait output.tipsSentTo');
  });
}

async function checkVideoPipeline(): Promise<void> {
  await check('video-pipeline (triggerAndWait) gets child output', async () => {
    const { detail } = await triggerAndPoll(
      'video-pipeline',
      { url: 'https://example.com/clip' },
      { expectStatus: 'completed', timeoutMs: DEFAULT_TIMEOUT_MS },
    );

    const out = detail.run.output as { audioUrl: string; childRunId: string; durationSec: number };
    assertEqual(out.audioUrl, 'https://example.com/clip.mp3', 'video-pipeline audioUrl');
    assert(out.durationSec === 42, `expected durationSec 42, got ${out.durationSec}`);
    assert(
      typeof out.childRunId === 'string' && out.childRunId.startsWith('run_'),
      'video-pipeline should reference a child run id',
    );

    // The parent should have a completed trigger-and-wait step.
    const taw = detail.steps.filter((s) => s.kind === 'trigger-and-wait');
    assert(taw.length === 1, `expected 1 'trigger-and-wait' step, got ${taw.length}`);

    // The child run should be completed and parented to this run.
    const child = await trigger.getRun(out.childRunId);
    assertEqual(child.status, 'completed', 'extract-audio child status');
    assertEqual(child.parentRunId, detail.run.id, 'child.parentRunId');
  });
}

async function checkFanOut(): Promise<void> {
  await check('fan-out (batchTrigger) produces 3 child runs', async () => {
    const { detail } = await triggerAndPoll(
      'fan-out',
      { names: ['x', 'y', 'z'] },
      { expectStatus: 'completed' },
    );

    const out = detail.run.output as { childRunIds: string[] };
    assert(Array.isArray(out.childRunIds), 'fan-out output.childRunIds must be an array');
    assert(
      out.childRunIds.length === 3,
      `expected 3 child run ids, got ${out.childRunIds.length}`,
    );

    // Each child must complete with a "hi <name>" output.
    const names = new Set(['x', 'y', 'z']);
    for (const id of out.childRunIds) {
      const child = await pollRun(id, { timeoutMs: DEFAULT_TIMEOUT_MS });
      assertEqual(child.detail.run.status, 'completed', `fan-out child ${id} status`);
      const childOut = child.detail.run.output;
      assert(
        typeof childOut === 'string' && /^hi [xyz]$/.test(childOut),
        `fan-out child ${id} output should be "hi <name>", got ${JSON.stringify(childOut)}`,
      );
      names.delete((childOut as string).slice(3));
    }
    assert(names.size === 0, `fan-out children should cover names x/y/z, missing: ${[...names]}`);

    // batch-trigger should be recorded as a single durable step.
    const bt = detail.steps.filter((s) => s.kind === 'batch-trigger');
    assert(bt.length === 1, `expected 1 'batch-trigger' step, got ${bt.length}`);
  });
}

async function checkIdempotency(): Promise<void> {
  await check('idempotency key: second trigger returns same runId + idempotent:true', async () => {
    const key = `idem-${Date.now()}`;
    const opts: TriggerOptions = { idempotencyKey: key };
    const first = await trigger.trigger('hello-world', { name: 'idem' }, opts);
    const second = await trigger.trigger('hello-world', { name: 'idem' }, opts);

    assertEqual(second.id, first.id, 'idempotent runId should match the first');
    assert(second.idempotent === true, 'second trigger should report idempotent:true');

    // (first.idempotent should be false — it created the run.)
    assert(first.idempotent === false, 'first trigger should report idempotent:false');
  });
}

async function checkAlwaysAborts(): Promise<void> {
  await check('always-aborts fails with attempt=1 (AbortError, no retry)', async () => {
    const { detail } = await triggerAndPoll(
      'always-aborts',
      { reason: 'test' },
      { expectStatus: 'failed' },
    );
    assert(detail.run.attempt === 1, `expected attempt 1 (no retry), got ${detail.run.attempt}`);
    assert(
      !!detail.run.error && typeof detail.run.error.message === 'string',
      'failed run should carry an error',
    );
  });
}

async function checkFlakyTask(): Promise<void> {
  await check('flaky-task completes on attempt 3 (retries with backoff)', async () => {
    // baseMs 500, factor 2 default → ~0.5s + ~1s backoffs (jittered) → give 20s.
    const { detail } = await triggerAndPoll(
      'flaky-task',
      {},
      { expectStatus: 'completed', timeoutMs: 20_000 },
    );
    assert(detail.run.attempt === 3, `expected attempt 3, got ${detail.run.attempt}`);
    const out = detail.run.output as { settledOnAttempt: number };
    assertEqual(out.settledOnAttempt, 3, 'flaky-task output.settledOnAttempt');
  });
}

async function checkParallelSteps(): Promise<void> {
  await check('parallel-steps completes; 2 step rows + logs attributed per seq', async () => {
    const { detail } = await triggerAndPoll(
      'parallel-steps',
      { a: 2, b: 5 },
      { expectStatus: 'completed' },
    );

    const out = detail.run.output as { a: number; b: number; sum: number };
    assertEqual(out.a, 4, 'parallel-steps output.a');
    assertEqual(out.b, 15, 'parallel-steps output.b');
    assertEqual(out.sum, 19, 'parallel-steps output.sum');

    // Exactly two 'step' rows: the two parallel siblings (no false-nesting abort).
    const userSteps = detail.steps.filter((s) => s.kind === 'step');
    assert(userSteps.length === 2, `expected 2 'step' rows, got ${userSteps.length}`);
    for (const s of userSteps) {
      assert(s.status === 'completed', `step seq ${s.seq} (${s.label}) not completed`);
    }

    // Map each label to its recorded seq, then assert each step's log carries
    // exactly that seq — i.e. AsyncLocalStorage attributed logs to the right
    // step even though both ran concurrently.
    const seqByLabel = new Map(userSteps.map((s) => [s.label, s.seq]));
    const seqA = seqByLabel.get('step-a');
    const seqB = seqByLabel.get('step-b');
    assert(seqA !== undefined && seqB !== undefined, 'both step labels must be recorded');

    const logA = detail.logs.find((l) => l.message === 'in step-a');
    const logB = detail.logs.find((l) => l.message === 'in step-b');
    assert(!!logA, 'missing "in step-a" log line');
    assert(!!logB, 'missing "in step-b" log line');
    assertEqual(logA!.stepSeq, seqA, '"in step-a" log should attach to step-a seq');
    assertEqual(logB!.stepSeq, seqB, '"in step-b" log should attach to step-b seq');
  });
}

async function checkSchedules(): Promise<void> {
  await check('schedules has every-minute with nextRunAt within 61s', async () => {
    const res = await pool.query<{
      task_id: string;
      cron_pattern: string;
      next_run_at: Date | null;
    }>('SELECT task_id, cron_pattern, next_run_at FROM schedules');
    const row = res.rows.find((s) => s.task_id === 'every-minute');
    assert(!!row, 'no schedule row for "every-minute"');
    assertEqual(row!.cron_pattern, '* * * * *', 'every-minute cron pattern');
    assert(!!row!.next_run_at, 'every-minute schedule has no nextRunAt');

    const next = new Date(row!.next_run_at!).getTime();
    const delta = next - Date.now();
    assert(
      delta > 0 && delta <= 61_000,
      `nextRunAt should be within the next 61s, got ${Math.round(delta / 1000)}s`,
    );
  });
}

async function checkCronFires(): Promise<void> {
  await check(`cron fires: every-2s (seconds pattern) completed a 'schedule' run`, async () => {
    // The pattern fires every 2s and the cron loop scans every 1s, so at most
    // ~3s should pass before a run exists + completes; allow 6s of polling.
    // (In practice the earlier checks already gave the scheduler ample time.)
    const deadline = Date.now() + 6_000;
    let firedId: string | undefined;
    for (;;) {
      const res = await pool.query<{ id: string }>(
        `SELECT id FROM runs
          WHERE task_id = 'every-2s' AND trigger_type = 'schedule' AND status = 'completed'
          ORDER BY created_at ASC
          LIMIT 1`,
      );
      firedId = res.rows[0]?.id;
      if (firedId || Date.now() >= deadline) break;
      await sleep(POLL_INTERVAL_MS);
    }
    assert(firedId, `no completed schedule-triggered 'every-2s' run within 6s`);

    // The instance API must agree on the trigger type.
    const rec = await trigger.getRun(firedId);
    assertEqual(rec.trigger, 'schedule', 'every-2s run triggerType');
    assertEqual(rec.status, 'completed', 'every-2s run status');

    // The schedule row must have advanced past the fired slot.
    const s = await pool.query<{
      cron_pattern: string;
      last_run_at: Date | null;
      last_run_id: string | null;
      next_run_at: Date | null;
    }>(
      `SELECT cron_pattern, last_run_at, last_run_id, next_run_at
         FROM schedules WHERE task_id = 'every-2s'`,
    );
    const row = s.rows[0];
    assert(!!row, `no schedule row for 'every-2s'`);
    assertEqual(row.cron_pattern, '*/2 * * * * *', 'every-2s cron pattern');
    assert(!!row.last_run_at && !!row.last_run_id, 'fired schedule should record last_run_at + last_run_id');
    assert(!!row.next_run_at, 'fired schedule should have a next_run_at');
    assert(
      row.next_run_at!.getTime() > row.last_run_at!.getTime(),
      `next_run_at (${row.next_run_at!.toISOString()}) should advance past the fired slot ` +
        `(last_run_at ${row.last_run_at!.toISOString()})`,
    );
  });
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */
async function main(): Promise<void> {
  console.log(`\nbetter-trigger e2e smoke test → ${daemon.url} (db ${DB_URL})\n`);
  const started = Date.now();

  await checkReady();
  await checkTasksRegistered();
  await checkHelloWorld();
  await checkOrderPipeline();
  await checkOnboardingWait();
  await checkVideoPipeline();
  await checkFanOut();
  await checkIdempotency();
  await checkAlwaysAborts();
  await checkFlakyTask();
  await checkParallelSteps();
  await checkSchedules();
  await checkCronFires();

  await daemon.stop();
  await pool.end();

  const totalMs = Date.now() - started;
  console.log(`\n${'-'.repeat(48)}`);
  console.log(`  ${passed} passed, ${failed} failed  (${(totalMs / 1000).toFixed(1)}s)`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log('');
    process.exit(1);
  }
  console.log('\nAll checks passed.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\ne2e harness crashed:', err);
  process.exit(1);
});
