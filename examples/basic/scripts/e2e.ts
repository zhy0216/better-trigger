/* =============================================================================
   @better-trigger/example-basic — end-to-end smoke test (contract §8, item 3).

   Assumes a server AND a worker are already running externally (see README:
   three terminals — server / worker / e2e). This script only talks to the
   server's HTTP API:
     - POST /api/v1/trigger     (enqueue runs)
     - GET  /api/v1/runs/:id    (poll a run; .steps asserts the durable ledger)
     - GET  /api/v1/schedules   (assert cron registration)
     - GET  /api/v1/tasks       (assert all tasks registered)

   Each check prints ✓/✗ with its elapsed time; a final summary follows.
   Any failed assertion makes the process exit(1).

   Env:
     BETTER_TRIGGER_API_URL  default http://localhost:4848
     BETTER_TRIGGER_API_KEY  optional; sent as Bearer if set.
   ============================================================================= */
import type {
  RunDetailResponse,
  RunStatus,
  SchedulesResponse,
  TasksResponse,
  TriggerOptions,
  TriggerResponse,
} from '@better-trigger/core';

/* ---------------------------------------------------------------------------
 * Config
 * ------------------------------------------------------------------------- */
const API_URL = (process.env.BETTER_TRIGGER_API_URL ?? 'http://localhost:4848').replace(/\/$/, '');
const API_KEY = process.env.BETTER_TRIGGER_API_KEY;

const TERMINAL: RunStatus[] = ['completed', 'failed', 'canceled'];
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;

/* ---------------------------------------------------------------------------
 * Tiny assertion + reporting harness
 * ------------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const failures: string[] = [];

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) };
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
  return h;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: authHeaders(body !== undefined ? { 'content-type': 'application/json' } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

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
 * Trigger + poll helpers
 * ------------------------------------------------------------------------- */
async function trigger(
  taskId: string,
  payload: unknown,
  options?: TriggerOptions,
): Promise<TriggerResponse> {
  return api<TriggerResponse>('POST', '/api/v1/trigger', { taskId, payload, options });
}

async function getRun(runId: string): Promise<RunDetailResponse> {
  return api<RunDetailResponse>('GET', `/api/v1/runs/${runId}`);
}

interface PollResult {
  detail: RunDetailResponse;
  /** Every distinct status observed while polling (incl. transient 'waiting'). */
  observed: Set<RunStatus>;
}

/**
 * Poll a run until it reaches a terminal state (or `expectStatus`, if given,
 * once seen alongside a terminal state). Returns the final detail plus the set
 * of statuses observed along the way (used to catch transient `waiting`).
 */
async function pollRun(
  runId: string,
  opts: { expectStatus?: RunStatus; timeoutMs?: number } = {},
): Promise<PollResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const observed = new Set<RunStatus>();
  let last: RunDetailResponse | undefined;

  while (Date.now() < deadline) {
    last = await getRun(runId);
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
  const { runId } = await trigger(taskId, payload, opts.options);
  const res = await pollRun(runId, { timeoutMs: opts.timeoutMs });
  if (opts.expectStatus) {
    assertEqual(res.detail.run.status, opts.expectStatus, `${taskId} run status`);
  }
  return res;
}

/* ---------------------------------------------------------------------------
 * Checks
 * ------------------------------------------------------------------------- */

async function checkHealth(): Promise<void> {
  await check('server is reachable (GET /health)', async () => {
    const h = await api<{ ok: boolean }>('GET', '/api/v1/health');
    assert(h.ok === true, 'health.ok must be true');
  });
}

async function checkTasksRegistered(): Promise<void> {
  await check('GET /tasks contains every example task', async () => {
    const { tasks } = await api<TasksResponse>('GET', '/api/v1/tasks');
    const ids = new Set(tasks.map((t) => t.id));
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
    ];
    for (const id of expected) {
      assert(ids.has(id), `task "${id}" missing from /tasks (worker not registered?)`);
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
    const { runId } = await trigger('onboarding-wait', { userId: 'u-wait' });
    const res = await pollRun(runId, { timeoutMs: DEFAULT_TIMEOUT_MS });
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
    const child = await getRun(out.childRunId);
    assertEqual(child.run.status, 'completed', 'extract-audio child status');
    assertEqual(child.run.parentRunId, detail.run.id, 'child.parentRunId');
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
    const first = await trigger('hello-world', { name: 'idem' }, { idempotencyKey: key });
    const second = await trigger('hello-world', { name: 'idem' }, { idempotencyKey: key });

    assertEqual(second.runId, first.runId, 'idempotent runId should match the first');
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
  await check('GET /schedules has every-minute with nextRunAt within 61s', async () => {
    const { schedules } = await api<SchedulesResponse>('GET', '/api/v1/schedules');
    const row = schedules.find((s) => s.taskId === 'every-minute');
    assert(!!row, 'no schedule row for "every-minute"');
    assertEqual(row!.cronPattern, '* * * * *', 'every-minute cron pattern');
    assert(!!row!.nextRunAt, 'every-minute schedule has no nextRunAt');

    const next = new Date(row!.nextRunAt!).getTime();
    const delta = next - Date.now();
    assert(
      delta > 0 && delta <= 61_000,
      `nextRunAt should be within the next 61s, got ${Math.round(delta / 1000)}s`,
    );
  });
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */
async function main(): Promise<void> {
  console.log(`\nbetter-trigger e2e smoke test → ${API_URL}\n`);
  const started = Date.now();

  // Preflight: make sure the server is up before firing the suite.
  try {
    await api<{ ok: boolean }>('GET', '/api/v1/health');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nServer not reachable at ${API_URL}.`);
    console.error('Start the server and worker first (see README). Detail:', msg, '\n');
    process.exit(1);
  }

  await checkHealth();
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
