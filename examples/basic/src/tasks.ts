/* =============================================================================
   @better-trigger/example-basic — example task set.

   Each task below demonstrates one or more SDK features (contract §6):
   the two task() signatures, ctx.step / ctx.wait / ctx.logger / ctx.now /
   ctx.uuid / ctx.run, durable replay memory, triggerAndWait + unwrapResult,
   batchTrigger fan-out, retry/backoff, AbortError, and cron schedules.

   These tasks are also the fixtures the e2e smoke test (scripts/e2e.ts)
   asserts against — keep ids/outputs in sync with that script.
   ============================================================================= */
import { task, AbortError, unwrapResult } from 'better-trigger';
import { z } from 'zod';

/* ---------------------------------------------------------------------------
 * hello-world — the minimal task(id, fn) signature.
 * Plain async function, payload in, value out. No ctx needed.
 * ------------------------------------------------------------------------- */
export const helloWorld = task(
  'hello-world',
  async (payload: { name: string }) => {
    return `hi ${payload.name}`;
  },
);

/* ---------------------------------------------------------------------------
 * order-pipeline — object signature with a zod schema, three sequential
 * steps, deterministic substitutes (ctx.now / ctx.uuid) and the logger.
 *
 * Demonstrates replay memory: on a re-run each completed step returns its
 * cached output without re-executing the fn, and ctx.now()/ctx.uuid() return
 * the same memoized values they produced on the first pass.
 * ------------------------------------------------------------------------- */
const orderSchema = z.object({
  customer: z.string(),
  items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })),
});

export const orderPipeline = task({
  id: 'order-pipeline',
  schema: orderSchema,
  run: async (payload, ctx) => {
    // ctx.uuid() — memoized deterministic id (kind 'uuid' step row).
    const orderId = await ctx.uuid();
    // ctx.now() — memoized deterministic timestamp (kind 'now' step row).
    const placedAt = await ctx.now();

    ctx.logger.info('order received', {
      orderId,
      customer: payload.customer,
      placedAt: placedAt.toISOString(),
    });

    // step 1 — validate.
    const validated = await ctx.step('validate-order', async () => {
      const total = payload.items.reduce((n, i) => n + i.qty, 0);
      if (total <= 0) throw new Error('empty order');
      return { itemCount: total };
    });

    // step 2 — charge.
    const charge = await ctx.step('charge-card', async () => {
      return { chargeId: `ch_${orderId}`, amount: validated.itemCount * 1000 };
    });

    // step 3 — fulfil.
    const shipment = await ctx.step('create-shipment', async () => {
      return { shipmentId: `shp_${orderId}`, items: validated.itemCount };
    });

    ctx.logger.info('order complete', { orderId, chargeId: charge.chargeId });

    return {
      orderId,
      placedAt: placedAt.toISOString(),
      chargeId: charge.chargeId,
      shipmentId: shipment.shipmentId,
      itemCount: validated.itemCount,
    };
  },
});

/* ---------------------------------------------------------------------------
 * onboarding-wait — step → ctx.wait.for("3s") → step.
 * Demonstrates suspend/resume: the run goes to `waiting`, the worker is
 * released, and the orchestrator timer re-queues it after 3s; replay skips
 * the already-completed first step and the satisfied wait.
 * ------------------------------------------------------------------------- */
export const onboardingWait = task({
  id: 'onboarding-wait',
  run: async (payload: { userId: string }, ctx) => {
    const created = await ctx.step('create-user', async () => {
      // Plain Date is fine INSIDE a step — the step's output is memoized.
      // (Never call ctx.now()/ctx.step() nested inside a step fn: it would
      // consume a seq that is skipped when the outer step replays from cache.)
      return { userId: payload.userId, createdAt: new Date().toISOString() };
    });

    ctx.logger.info('user created, cooling off before tips', created);

    // Suspend here — run becomes `waiting` for ~3s, then resumes via replay.
    await ctx.wait.for('3s');

    const tips = await ctx.step('send-tips', async () => {
      return { sentTo: created.userId };
    });

    return { userId: created.userId, tipsSentTo: tips.sentTo };
  },
});

/* ---------------------------------------------------------------------------
 * extract-audio — child task used by video-pipeline below.
 * ------------------------------------------------------------------------- */
export const extractAudio = task(
  'extract-audio',
  async (payload: { url: string }) => {
    return { audioUrl: `${payload.url}.mp3`, durationSec: 42 };
  },
);

/* ---------------------------------------------------------------------------
 * video-pipeline — parent that calls extract-audio via triggerAndWait and
 * unwraps the child result. Demonstrates parent/child suspend (the parent
 * goes `waiting` until the child reaches a terminal state) and unwrapResult.
 * ------------------------------------------------------------------------- */
export const videoPipeline = task({
  id: 'video-pipeline',
  run: async (payload: { url: string }, ctx) => {
    ctx.logger.info('starting video pipeline', { url: payload.url });

    // triggerAndWait returns a TaskRunResult (never throws on child failure).
    const result = await extractAudio.triggerAndWait({ url: payload.url });

    // unwrapResult throws if the child failed; returns child output otherwise.
    const audio = unwrapResult(result);

    return {
      url: payload.url,
      childRunId: result.id,
      audioUrl: audio.audioUrl,
      durationSec: audio.durationSec,
    };
  },
});

/* ---------------------------------------------------------------------------
 * fan-out — dispatches 3 hello-world children via batchTrigger.
 * Demonstrates durable batchTrigger from inside a task (one memoized
 * 'batch-trigger' step row holding the produced child run ids).
 * ------------------------------------------------------------------------- */
export const fanOut = task({
  id: 'fan-out',
  run: async (payload: { names: string[] }, ctx) => {
    const handles = await helloWorld.batchTrigger(
      payload.names.map((name) => ({ payload: { name } })),
    );
    ctx.logger.info('fanned out', { count: handles.length });
    return { childRunIds: handles.map((h) => h.id) };
  },
});

/* ---------------------------------------------------------------------------
 * flaky-task — fails on attempts 1 and 2, succeeds on attempt 3.
 * Uses ctx.run.attempt (cleanest — no external counter file). retry policy
 * gives it up to 3 attempts with a short backoff so the e2e test stays fast.
 * ------------------------------------------------------------------------- */
export const flakyTask = task({
  id: 'flaky-task',
  retry: { maxAttempts: 3, baseMs: 500 },
  run: async (_payload: Record<string, never>, ctx) => {
    ctx.logger.info('flaky attempt', { attempt: ctx.run.attempt });
    if (ctx.run.attempt < 3) {
      throw new Error(`transient failure on attempt ${ctx.run.attempt}`);
    }
    return { settledOnAttempt: ctx.run.attempt };
  },
});

/* ---------------------------------------------------------------------------
 * always-aborts — throws AbortError, which fails the run immediately with
 * no retries (attempt stays 1).
 * ------------------------------------------------------------------------- */
export const alwaysAborts = task({
  id: 'always-aborts',
  retry: { maxAttempts: 3 },
  run: async (_payload: { reason?: string }) => {
    throw new AbortError('aborting on purpose — no retry expected');
  },
});

/* ---------------------------------------------------------------------------
 * typo-wait — the "typo'd child task id" acceptance case (todos/p1-04).
 * Calls ctx.triggerAndWait against a raw STRING id that no task registered
 * ('no-such-task-xyz') — the typo path. waitForChildRun rejects it with
 * TaskNotFoundError (code task_not_found), which the executor converts to a
 * non-retryable AbortError, so the parent run FAILS with attempt staying 1.
 * The error is deliberately NOT caught: this task's job is to fail the run.
 * ------------------------------------------------------------------------- */
export const typoWait = task({
  id: 'typo-wait',
  run: async (_payload: Record<string, never>, ctx) => {
    return await ctx.triggerAndWait('no-such-task-xyz', {});
  },
});

/* ---------------------------------------------------------------------------
 * parallel-steps — two durable steps run concurrently via Promise.all.
 * Demonstrates that parallel (non-nested) siblings are supported: seq is
 * allocated synchronously before each step awaits its fn, so positions stay
 * stable, and AsyncLocalStorage keeps each step's logs attributed to its own
 * seq (no false nesting AbortError, no log-attribution crosstalk).
 * ------------------------------------------------------------------------- */
export const parallelSteps = task({
  id: 'parallel-steps',
  run: async (payload: { a: number; b: number }, ctx) => {
    const [a, b] = await Promise.all([
      ctx.step('step-a', async () => {
        ctx.logger.info('in step-a', { value: payload.a });
        return payload.a * 2;
      }),
      ctx.step('step-b', async () => {
        ctx.logger.info('in step-b', { value: payload.b });
        return payload.b * 3;
      }),
    ]);
    return { a, b, sum: a + b };
  },
});

/* ---------------------------------------------------------------------------
 * every-minute — a cron task. Empty body; the point is that registering it
 * upserts a `schedules` row with a future next_run_at.
 * ------------------------------------------------------------------------- */
export const everyMinute = task({
  id: 'every-minute',
  cron: '* * * * *',
  run: async () => {
    // intentionally empty — schedule registration is what we demonstrate.
  },
});

/* ---------------------------------------------------------------------------
 * every-2s — a 6-field (seconds-granularity) cron task that actually FIRES
 * during the e2e run: the pattern below means "every 2 seconds" (croner
 * supports the leading seconds field; the SDK passes the pattern through
 * verbatim). The e2e asserts at least one completed run with triggerType
 * 'schedule' and that next_run_at advances past the fired slot.
 * ------------------------------------------------------------------------- */
export const everyTwoSeconds = task({
  id: 'every-2s',
  cron: '*/2 * * * * *',
  run: async () => 'tick',
});

/* ---------------------------------------------------------------------------
 * The full set, exported for the worker entrypoint.
 * ------------------------------------------------------------------------- */
export const allTasks = [
  helloWorld,
  orderPipeline,
  onboardingWait,
  extractAudio,
  videoPipeline,
  fanOut,
  flakyTask,
  alwaysAborts,
  typoWait,
  parallelSteps,
  everyMinute,
  everyTwoSeconds,
];
