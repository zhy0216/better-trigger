/* =============================================================================
   @better-trigger/example-basic — end-to-end smoke test.

   Runs on @better-trigger/testing: runScenario provisions the scenario's
   database (better_trigger_e2e), owns the pool, runs teardown and folds every
   ✓/✗ into the exit code; startDaemon spawns the worker over src/tasks.ts and
   waits for its health endpoint. Every check then goes through the HTTP client —
   exactly the path an application takes:
     - trigger.trigger / handle.result   (enqueue + await runs)
     - trigger.getRunDetail / getRun     (poll runs; .steps asserts the ledger)
     - direct SQL on tasks / schedules   (registration + cron assertions)

   The database is provisioned but NOT migrated here: this is the one scenario
   where the daemon's own `--migrate` path is part of what is under test.

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
import {
  AssertionFailure,
  portFromEnv,
  runScenario,
  startDaemon,
  waitFor,
  type Scenario,
} from '@better-trigger/testing';
import {
  betterTrigger,
  type BetterTrigger,
  type RunDetailResult,
  type RunStatus,
  type TriggerOptions,
} from 'better-trigger';

/* ---------------------------------------------------------------------------
 * Config
 * ------------------------------------------------------------------------- */
const PORT = portFromEnv('BT_E2E_PORT', 4901);
const TASKS_MODULE = fileURLToPath(new URL('../src/tasks.ts', import.meta.url));

const TERMINAL: RunStatus[] = ['completed', 'failed', 'canceled'];
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;

/* ---------------------------------------------------------------------------
 * Scenario context — the scenario handle plus the two poll helpers every check
 * builds on. Passed explicitly so the checks stay top-level functions.
 * ------------------------------------------------------------------------- */
interface PollResult {
  detail: RunDetailResult;
  /** Every distinct status observed while polling (incl. transient 'waiting'). */
  observed: Set<RunStatus>;
}

interface E2E {
  s: Scenario;
  /** The client under test — HTTP only, exactly what an app would hold. */
  trigger: BetterTrigger;
  /**
   * Poll a run until it reaches a terminal state. Returns the final detail plus
   * the set of statuses observed along the way (used to catch transient
   * `waiting`).
   */
  pollRun(runId: string, opts?: { timeoutMs?: number }): Promise<PollResult>;
  /** Trigger then poll to terminal; assert the terminal status matches. */
  triggerAndPoll(
    taskId: string,
    payload: unknown,
    opts?: { expectStatus?: RunStatus; timeoutMs?: number; options?: TriggerOptions },
  ): Promise<PollResult>;
}

function context(s: Scenario, trigger: BetterTrigger): E2E {
  async function pollRun(runId: string, opts: { timeoutMs?: number } = {}): Promise<PollResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const observed = new Set<RunStatus>();
    let last: RunDetailResult | undefined;

    await waitFor(
      `run ${runId} to settle`,
      timeoutMs,
      async () => {
        last = await trigger.getRunDetail(runId);
        observed.add(last.run.status);
        return TERMINAL.includes(last.run.status);
      },
      { intervalMs: POLL_INTERVAL_MS },
    ).catch(() => {
      const got = last ? last.run.status : 'unknown';
      throw new AssertionFailure(
        `run ${runId} did not settle within ${timeoutMs}ms (last status: ${got})`,
      );
    });
    return { detail: last!, observed };
  }

  async function triggerAndPoll(
    taskId: string,
    payload: unknown,
    opts: { expectStatus?: RunStatus; timeoutMs?: number; options?: TriggerOptions } = {},
  ): Promise<PollResult> {
    const handle = await trigger.trigger(taskId, payload, opts.options);
    const res = await pollRun(handle.id, { timeoutMs: opts.timeoutMs });
    if (opts.expectStatus) {
      s.assertEqual(res.detail.run.status, opts.expectStatus, `${taskId} run status`);
    }
    return res;
  }

  return { s, trigger, pollRun, triggerAndPoll };
}

/** A run that reached a terminal state, remembered for the invariant sweep. */
interface Settled {
  label: string;
  runId: string;
}

/* ---------------------------------------------------------------------------
 * Checks
 *
 * Each one opens with `const s: Scenario = c.s`. That annotation is load-
 * bearing, not noise: TypeScript only honours an `asserts cond` signature
 * (s.assert) when the call target's name was declared with an explicit type,
 * and a destructuring pattern does not count (TS2775).
 * ------------------------------------------------------------------------- */

async function checkReady(c: E2E): Promise<void> {
  const s: Scenario = c.s;
  const { trigger } = c;
  await s.check('daemon is ready (health + migrated db + worker registered)', async () => {
    const health = await trigger.health();
    s.assert(health.ok === true, 'GET /health must report ok');

    const h = await s.pool.query('SELECT 1 AS ok');
    s.assert(h.rows[0]?.ok === 1, 'database must answer SELECT 1');

    const w = await s.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM workers WHERE status = 'online'`,
    );
    s.assert(w.rows.length === 1, `expected 1 online worker row, got ${w.rows.length}`);
  });
}

async function checkTasksRegistered(c: E2E): Promise<void> {
  const s: Scenario = c.s;
  await s.check('tasks table contains every example task', async () => {
    const res = await s.pool.query<{ id: string }>('SELECT id FROM tasks');
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
      s.assert(ids.has(id), `task "${id}" missing from tasks (worker not registered?)`);
    }
  });
}

async function checkHelloWorld(c: E2E): Promise<void> {
  const s: Scenario = c.s;
  const { triggerAndPoll } = c;
  await s.check('hello-world completes with correct output', async () => {
    const { detail } = await triggerAndPoll(
      'hello-world',
      { name: 'ada' },
      { expectStatus: 'completed' },
    );
    s.assertEqual(detail.run.output, 'hi ada', 'hello-world output');
  });
}

async function checkOrderPipeline(c: E2E, settled: Settled[]): Promise<void> {
  const s: Scenario = c.s;
  const { triggerAndPoll } = c;
  await s.check('order-pipeline completes with the expected step ledger', async () => {
    const { detail } = await triggerAndPoll(
      'order-pipeline',
      { customer: 'ada', items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] },
      { expectStatus: 'completed' },
    );
    settled.push({ label: 'order-pipeline', runId: detail.run.id });

    const steps = detail.steps;
    const byKind = (k: string) => steps.filter((step) => step.kind === k);

    // 3 user steps recorded exactly. The deterministic substitutes (uuid/now)
    // are reported asynchronously (contract §3.8), so assert >= 1 rather than
    // an exact count to stay race-free.
    const userSteps = byKind('step');
    s.assert(userSteps.length === 3, `expected 3 'step' rows, got ${userSteps.length}`);
    s.assert(byKind('uuid').length >= 1, `expected a 'uuid' row, got ${byKind('uuid').length}`);
    s.assert(byKind('now').length >= 1, `expected a 'now' row, got ${byKind('now').length}`);

    const labels = userSteps.map((step) => step.label).sort();
    s.assertEqual(
      labels,
      ['charge-card', 'create-shipment', 'validate-order'],
      'order-pipeline step labels',
    );

    // every recorded step must be completed.
    for (const step of steps) {
      s.assert(step.status === 'completed', `step seq ${step.seq} (${step.kind}) not completed`);
    }

    const out = detail.run.output as { itemCount: number; orderId: string };
    s.assert(out.itemCount === 3, `expected itemCount 3, got ${out.itemCount}`);
    s.assert(typeof out.orderId === 'string' && out.orderId.length > 0, 'orderId should be a uuid');
  });
}

async function checkOnboardingWait(c: E2E, settled: Settled[]): Promise<void> {
  const s: Scenario = c.s;
  const { trigger, pollRun } = c;
  await s.check('onboarding-wait suspends (waiting) then resumes; total >= 3s', async () => {
    const t0 = Date.now();
    const handle = await trigger.trigger('onboarding-wait', { userId: 'u-wait' });
    const res = await pollRun(handle.id, { timeoutMs: DEFAULT_TIMEOUT_MS });
    const elapsed = Date.now() - t0;
    settled.push({ label: 'onboarding-wait', runId: handle.id });

    s.assert(res.observed.has('waiting'), 'never observed a `waiting` status while polling');
    s.assertEqual(res.detail.run.status, 'completed', 'onboarding-wait final status');
    s.assert(elapsed >= 3_000, `expected >= 3000ms total, got ${elapsed}ms`);

    // The wait should be recorded as a completed step (kind 'wait').
    const waitSteps = res.detail.steps.filter((step) => step.kind === 'wait');
    s.assert(waitSteps.length === 1, `expected 1 'wait' step row, got ${waitSteps.length}`);

    const out = res.detail.run.output as { tipsSentTo: string };
    s.assertEqual(out.tipsSentTo, 'u-wait', 'onboarding-wait output.tipsSentTo');
  });
}

async function checkVideoPipeline(c: E2E): Promise<void> {
  const s: Scenario = c.s;
  const { trigger, triggerAndPoll } = c;
  await s.check('video-pipeline (triggerAndWait) gets child output', async () => {
    const { detail } = await triggerAndPoll(
      'video-pipeline',
      { url: 'https://example.com/clip' },
      { expectStatus: 'completed', timeoutMs: DEFAULT_TIMEOUT_MS },
    );

    const out = detail.run.output as { audioUrl: string; childRunId: string; durationSec: number };
    s.assertEqual(out.audioUrl, 'https://example.com/clip.mp3', 'video-pipeline audioUrl');
    s.assert(out.durationSec === 42, `expected durationSec 42, got ${out.durationSec}`);
    s.assert(
      typeof out.childRunId === 'string' && out.childRunId.startsWith('run_'),
      'video-pipeline should reference a child run id',
    );

    // The parent should have a completed trigger-and-wait step.
    const taw = detail.steps.filter((step) => step.kind === 'trigger-and-wait');
    s.assert(taw.length === 1, `expected 1 'trigger-and-wait' step, got ${taw.length}`);

    // The child run should be completed and parented to this run.
    const child = await trigger.getRun(out.childRunId);
    s.assertEqual(child.status, 'completed', 'extract-audio child status');
    s.assertEqual(child.parentRunId, detail.run.id, 'child.parentRunId');
  });
}

async function checkFanOut(c: E2E): Promise<void> {
  const s: Scenario = c.s;
  const { pollRun, triggerAndPoll } = c;
  await s.check('fan-out (batchTrigger) produces 3 child runs', async () => {
    const { detail } = await triggerAndPoll(
      'fan-out',
      { names: ['x', 'y', 'z'] },
      { expectStatus: 'completed' },
    );

    const out = detail.run.output as { childRunIds: string[] };
    s.assert(Array.isArray(out.childRunIds), 'fan-out output.childRunIds must be an array');
    s.assert(
      out.childRunIds.length === 3,
      `expected 3 child run ids, got ${out.childRunIds.length}`,
    );

    // Each child must complete with a "hi <name>" output.
    const names = new Set(['x', 'y', 'z']);
    for (const id of out.childRunIds) {
      const child = await pollRun(id, { timeoutMs: DEFAULT_TIMEOUT_MS });
      s.assertEqual(child.detail.run.status, 'completed', `fan-out child ${id} status`);
      const childOut = child.detail.run.output;
      s.assert(
        typeof childOut === 'string' && /^hi [xyz]$/.test(childOut),
        `fan-out child ${id} output should be "hi <name>", got ${JSON.stringify(childOut)}`,
      );
      names.delete((childOut as string).slice(3));
    }
    s.assert(names.size === 0, `fan-out children should cover names x/y/z, missing: ${[...names]}`);

    // batch-trigger should be recorded as a single durable step.
    const bt = detail.steps.filter((step) => step.kind === 'batch-trigger');
    s.assert(bt.length === 1, `expected 1 'batch-trigger' step, got ${bt.length}`);
  });
}

async function checkIdempotency(c: E2E): Promise<void> {
  const s: Scenario = c.s;
  const { trigger } = c;
  await s.check('idempotency key: second trigger returns same runId + idempotent:true', async () => {
    const key = `idem-${Date.now()}`;
    const opts: TriggerOptions = { idempotencyKey: key };
    const first = await trigger.trigger('hello-world', { name: 'idem' }, opts);
    const second = await trigger.trigger('hello-world', { name: 'idem' }, opts);

    s.assertEqual(second.id, first.id, 'idempotent runId should match the first');
    s.assert(second.idempotent === true, 'second trigger should report idempotent:true');

    // (first.idempotent should be false — it created the run.)
    s.assert(first.idempotent === false, 'first trigger should report idempotent:false');
  });
}

async function checkAlwaysAborts(c: E2E, settled: Settled[]): Promise<void> {
  const s: Scenario = c.s;
  const { triggerAndPoll } = c;
  await s.check('always-aborts fails with attempt=1 (AbortError, no retry)', async () => {
    const { detail } = await triggerAndPoll(
      'always-aborts',
      { reason: 'test' },
      { expectStatus: 'failed' },
    );
    settled.push({ label: 'always-aborts', runId: detail.run.id });
    s.assert(detail.run.attempt === 1, `expected attempt 1 (no retry), got ${detail.run.attempt}`);
    s.assert(
      !!detail.run.error && typeof detail.run.error.message === 'string',
      'failed run should carry an error',
    );
  });
}

async function checkFlakyTask(c: E2E, settled: Settled[]): Promise<void> {
  const s: Scenario = c.s;
  const { triggerAndPoll } = c;
  await s.check('flaky-task completes on attempt 3 (retries with backoff)', async () => {
    // baseMs 500, factor 2 default → ~0.5s + ~1s backoffs (jittered) → give 20s.
    const { detail } = await triggerAndPoll(
      'flaky-task',
      {},
      { expectStatus: 'completed', timeoutMs: 20_000 },
    );
    settled.push({ label: 'flaky-task', runId: detail.run.id });
    s.assert(detail.run.attempt === 3, `expected attempt 3, got ${detail.run.attempt}`);
    const out = detail.run.output as { settledOnAttempt: number };
    s.assertEqual(out.settledOnAttempt, 3, 'flaky-task output.settledOnAttempt');
  });
}

async function checkParallelSteps(c: E2E, settled: Settled[]): Promise<void> {
  const s: Scenario = c.s;
  const { triggerAndPoll } = c;
  await s.check('parallel-steps completes; 2 step rows + logs attributed per seq', async () => {
    const { detail } = await triggerAndPoll(
      'parallel-steps',
      { a: 2, b: 5 },
      { expectStatus: 'completed' },
    );
    settled.push({ label: 'parallel-steps', runId: detail.run.id });

    const out = detail.run.output as { a: number; b: number; sum: number };
    s.assertEqual(out.a, 4, 'parallel-steps output.a');
    s.assertEqual(out.b, 15, 'parallel-steps output.b');
    s.assertEqual(out.sum, 19, 'parallel-steps output.sum');

    // Exactly two 'step' rows: the two parallel siblings (no false-nesting abort).
    const userSteps = detail.steps.filter((step) => step.kind === 'step');
    s.assert(userSteps.length === 2, `expected 2 'step' rows, got ${userSteps.length}`);
    for (const step of userSteps) {
      s.assert(step.status === 'completed', `step seq ${step.seq} (${step.label}) not completed`);
    }

    // Map each label to its recorded seq, then assert each step's log carries
    // exactly that seq — i.e. AsyncLocalStorage attributed logs to the right
    // step even though both ran concurrently.
    const seqByLabel = new Map(userSteps.map((step) => [step.label, step.seq]));
    const seqA = seqByLabel.get('step-a');
    const seqB = seqByLabel.get('step-b');
    s.assert(seqA !== undefined && seqB !== undefined, 'both step labels must be recorded');

    const logA = detail.logs.find((l) => l.message === 'in step-a');
    const logB = detail.logs.find((l) => l.message === 'in step-b');
    s.assert(!!logA, 'missing "in step-a" log line');
    s.assert(!!logB, 'missing "in step-b" log line');
    s.assertEqual(logA!.stepSeq, seqA, '"in step-a" log should attach to step-a seq');
    s.assertEqual(logB!.stepSeq, seqB, '"in step-b" log should attach to step-b seq');
  });
}

async function checkSchedules(c: E2E): Promise<void> {
  const s: Scenario = c.s;
  await s.check('schedules has every-minute with nextRunAt within 61s', async () => {
    const res = await s.pool.query<{
      task_id: string;
      cron_pattern: string;
      next_run_at: Date | null;
    }>('SELECT task_id, cron_pattern, next_run_at FROM schedules');
    const row = res.rows.find((sched) => sched.task_id === 'every-minute');
    s.assert(!!row, 'no schedule row for "every-minute"');
    s.assertEqual(row!.cron_pattern, '* * * * *', 'every-minute cron pattern');
    s.assert(!!row!.next_run_at, 'every-minute schedule has no nextRunAt');

    const next = new Date(row!.next_run_at!).getTime();
    const delta = next - Date.now();
    // Lower bound is deliberately in the past: scanCron ticks every 1s, so a due
    // deadline legitimately sits a tick or two behind now() until the scan
    // advances it. Requiring delta > 0 made this check fire on that window.
    s.assert(
      delta > -5_000 && delta <= 61_000,
      `nextRunAt should be within the next 61s, got ${Math.round(delta / 1000)}s`,
    );
  });
}

async function checkCronFires(c: E2E): Promise<void> {
  const s: Scenario = c.s;
  const { trigger } = c;
  await s.check(`cron fires: every-2s (seconds pattern) completed a 'schedule' run`, async () => {
    // The pattern fires every 2s and the cron loop scans every 1s, so at most
    // ~3s should pass before a run exists + completes; allow 6s of polling.
    // (In practice the earlier checks already gave the scheduler ample time.)
    let firedId: string | undefined;
    await waitFor(
      `a completed schedule-triggered 'every-2s' run`,
      6_000,
      async () => {
        const res = await s.pool.query<{ id: string }>(
          `SELECT id FROM runs
            WHERE task_id = 'every-2s' AND trigger_type = 'schedule' AND status = 'completed'
            ORDER BY created_at ASC
            LIMIT 1`,
        );
        firedId = res.rows[0]?.id;
        return !!firedId;
      },
      { intervalMs: POLL_INTERVAL_MS },
    ).catch(() => {
      throw new AssertionFailure(`no completed schedule-triggered 'every-2s' run within 6s`);
    });
    s.assert(firedId, `no completed schedule-triggered 'every-2s' run within 6s`);

    // The instance API must agree on the trigger type.
    const rec = await trigger.getRun(firedId);
    s.assertEqual(rec.trigger, 'schedule', 'every-2s run triggerType');
    s.assertEqual(rec.status, 'completed', 'every-2s run status');

    // The schedule row must have advanced past the fired slot.
    const sched = await s.pool.query<{
      cron_pattern: string;
      last_run_at: Date | null;
      last_run_id: string | null;
      next_run_at: Date | null;
    }>(
      `SELECT cron_pattern, last_run_at, last_run_id, next_run_at
         FROM schedules WHERE task_id = 'every-2s'`,
    );
    const row = sched.rows[0];
    s.assert(!!row, `no schedule row for 'every-2s'`);
    s.assertEqual(row.cron_pattern, '*/2 * * * * *', 'every-2s cron pattern');
    s.assert(
      !!row.last_run_at && !!row.last_run_id,
      'fired schedule should record last_run_at + last_run_id',
    );
    s.assert(!!row.next_run_at, 'fired schedule should have a next_run_at');
    s.assert(
      row.next_run_at!.getTime() > row.last_run_at!.getTime(),
      `next_run_at (${row.next_run_at!.toISOString()}) should advance past the fired slot ` +
        `(last_run_at ${row.last_run_at!.toISOString()})`,
    );
  });
}

/**
 * The shared durable-execution invariants, read straight off the ledger long
 * after each run settled — so "terminal means terminal" is asserted against a
 * window of many seconds, not against the instant the client saw 'completed'.
 */
async function checkLedgerInvariants(c: E2E, settled: Settled[]): Promise<void> {
  const s: Scenario = c.s;
  for (const { label, runId } of settled) {
    await s.check(`${label}: ledger invariants (seq contiguous, append-only, terminal frozen)`, async () => {
      await s.inv.assertSeqContiguous(runId);
      await s.inv.assertNoStepRewrites(runId);
      await s.inv.assertTerminalImmutable(runId);
    });
  }
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */
async function main(s: Scenario): Promise<void> {
  // One daemon: it migrates, loads src/tasks.ts, executes, and serves the API.
  const daemon = await startDaemon({
    databaseUrl: s.db.url,
    port: PORT,
    tasks: TASKS_MODULE,
    concurrency: 5,
    migrate: true,
  });
  s.cleanup(() => daemon.stop());
  s.log(`daemon ${daemon.url}`);

  const c = context(s, betterTrigger({ url: daemon.url! }));
  const settled: Settled[] = [];

  await checkReady(c);
  await checkTasksRegistered(c);
  await checkHelloWorld(c);
  await checkOrderPipeline(c, settled);
  await checkOnboardingWait(c, settled);
  await checkVideoPipeline(c);
  await checkFanOut(c);
  await checkIdempotency(c);
  await checkAlwaysAborts(c, settled);
  await checkFlakyTask(c, settled);
  await checkParallelSteps(c, settled);
  await checkSchedules(c);
  await checkCronFires(c);
  await checkLedgerInvariants(c, settled);
}

await runScenario(
  {
    name: 'e2e',
    what: 'end-to-end smoke test over the HTTP client',
    // Not migrated here on purpose: the daemon's own `--migrate` is under test.
    db: { name: 'better_trigger_e2e', envVar: 'BT_E2E_DB', migrate: false },
  },
  main,
);
