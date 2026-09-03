/* =============================================================================
   @better-trigger/kernel — suspendRun's `work` notification against a real
   Postgres (p2-41).

   suspendRun's non-immediate path releases the run's concurrency slot (waiting
   flip + queue-row delete), which makes queued runs sharing its concurrency_key
   claimable. The tx must say so — `SELECT pg_notify('bt', '{"type":"work"}')`
   as its LAST statement — so a claim loop parked in its 300ms→2s idle backoff
   (apps/worker/src/runtime.ts) wakes at COMMIT instead of at the next poll.

   This suite drives the real kernel and listens on the real channel with a
   dedicated pg client:

     - a keyed suspend delivers `work` shortly after COMMIT — latency evidence
       against the idle-backoff floor, not just "eventually" — and the queued
       successor is immediately claimable;
     - the already-due path (resumed:true), which keeps the claim and the slot,
       sends nothing;
     - a suspend without a concurrency_key sends nothing;
     - a rejected suspend (run_not_running) rolls back and its notification
       never lands — the polling fallback is untouched, so the state machine
       and later legal writes still work;
     - concurrent suspends of several keyed runs deliver ≥1 aggregate
       notification (pg coalesces per tx; exact count is not promised) and
       leave the state machine intact.
   ============================================================================= */
import { expect, it } from 'vitest';
import { Client } from 'pg';
import { describePg, withPg, type PgContext } from './helpers';
import { RunNotRunningError } from '../../src/index';
import { NOTIFY_CHANNEL } from '../../src/notify';

const NS = { projectId: 'default', env: 'prod' };
const TASK = 'suspend-notify-task';
const KEY = 'tenant-42';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Received {
  channel: string;
  payload: unknown;
  at: number;
}

/**
 * A dedicated LISTEN connection on the provisioned database — the same channel
 * the worker daemon's fast-path client listens on (apps/worker/src/notify.ts).
 * Notifications are recorded with their payload and arrival timestamp.
 */
async function attachListener(
  ctx: PgContext,
): Promise<{ received: Received[]; close: () => Promise<void> }> {
  const client = new Client({ connectionString: ctx.db.url });
  const received: Received[] = [];
  client.on('notification', (msg) => {
    received.push({
      channel: msg.channel,
      payload: JSON.parse(msg.payload ?? 'null') as unknown,
      at: Date.now(),
    });
  });
  await client.connect();
  await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
  return {
    received,
    close: () => client.end(),
  };
}

/**
 * Wait until the listener has at least `atLeast` notifications. Used to drain
 * the setup noise (every trigger notifies on enqueue) BEFORE a measurement, so
 * the quiet windows and baselines below observe exactly the suspend's own tx.
 * A missing setup notification is itself a regression and fails the test.
 */
async function drainSetup(
  received: Received[],
  atLeast: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (received.length < atLeast) {
    if (Date.now() > deadline) {
      throw new Error(
        `expected ≥${atLeast} setup notification(s), got ${received.length} after ${timeoutMs}ms`,
      );
    }
    await sleep(5);
  }
}

/** The FIRST notification received after `baseline`, or null on timeout. */
async function nextNotification(
  received: Received[],
  baseline: number,
  timeoutMs: number,
): Promise<Received | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.length > baseline) return received[baseline]!;
    await sleep(5);
  }
  return null;
}

/** The next `count` notifications received after `baseline` (order-preserved). */
async function nextNotifications(
  received: Received[],
  baseline: number,
  count: number,
  timeoutMs: number,
): Promise<Received[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.length >= baseline + count) {
      return received.slice(baseline, baseline + count);
    }
    await sleep(5);
  }
  return received.slice(baseline, Math.min(baseline + count, received.length));
}

/**
 * Register a worker serving TASK with the given concurrency limit, trigger
 * `count` keyed runs (all sharing KEY) and claim up to `claimLimit` of them.
 * Returns the worker id, the claims and every triggered run id (in order).
 */
async function setupKeyedRuns(
  ctx: PgContext,
  opts: { limit: number; count: number; claimLimit: number },
): Promise<{ workerId: string; claims: { id: string; fencingToken: number }[]; runIds: string[] }> {
  const { kernel } = ctx;
  const { workerId } = await kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: opts.limit,
    namespaces: [NS],
    tasks: [{ id: TASK, codeVersion: 'v1', concurrencyLimit: opts.limit }],
  });
  const runIds: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const created = await kernel.trigger({
      taskId: TASK,
      payload: { i },
      options: { concurrencyKey: KEY },
      namespace: NS,
    });
    runIds.push(created.runId);
  }
  const claimed = await kernel.claimRuns({
    workerId,
    namespaces: [NS],
    taskIds: [TASK],
    limit: opts.claimLimit,
    leaseMs: 60_000,
  });
  return {
    workerId,
    claims: claimed.map((c) => ({ id: c.id, fencingToken: c.fencingToken })),
    runIds,
  };
}

describePg('suspend work notification (p2-41)', () => {
  it('keyed suspend delivers work right after COMMIT and unblocks the queued successor', async () => {
    await withPg('suspend_notify_slot', async (ctx) => {
      const { kernel, pool } = ctx;
      const listener = await attachListener(ctx);
      try {
        const { workerId, claims, runIds } = await setupKeyedRuns(ctx, {
          limit: 1,
          count: 2,
          claimLimit: 1,
        });
        expect(claims).toHaveLength(1);
        const a = claims[0]!;

        // The second run stays queued: the key's running count (A) hits limit 1.
        const blocked = await kernel.claimRuns({
          workerId,
          namespaces: [NS],
          taskIds: [TASK],
          limit: 1,
          leaseMs: 60_000,
        });
        expect(blocked).toHaveLength(0);

        // Both triggers notified on enqueue; drain them before measuring.
        await drainSetup(listener.received, 2);
        const baseline = listener.received.length;

        const t0 = Date.now();
        const res = await kernel.suspendRun({
          runId: a.id,
          namespace: NS,
          seq: 0,
          kind: 'duration',
          resumeAt: new Date(Date.now() + 60_000).toISOString(),
          workerId,
          fencingToken: a.fencingToken,
        });
        expect(res).toEqual({ resumed: false });

        const msg = await nextNotification(listener.received, baseline, 2_000);
        expect(msg).not.toBeNull();
        expect(msg!.channel).toBe(NOTIFY_CHANNEL);
        // 05-T3: the wake names the namespace the slot was released in.
        expect(msg!.payload).toEqual({ type: 'work', projectId: NS.projectId, env: NS.env });
        // Latency evidence: pg_notify is delivered at COMMIT, i.e. milliseconds
        // after suspendRun resolved — far under the claim loop's 300ms idle
        // backoff floor (and its ~2s ceiling), so a sleeping claim loop wakes
        // immediately instead of waiting out the next poll.
        expect(msg!.at - t0).toBeLessThan(500);

        // State machine result unchanged: the successor is claimable NOW.
        const claimedB = await kernel.claimRuns({
          workerId,
          namespaces: [NS],
          taskIds: [TASK],
          limit: 1,
          leaseMs: 60_000,
        });
        expect(claimedB).toHaveLength(1);
        expect(claimedB[0]!.id).toBe(runIds[1]);

        // A is waiting with its queue row gone.
        const runA = await pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [a.id],
        );
        expect(runA.rows[0]!.status).toBe('waiting');
        const queueA = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM queue WHERE run_id = $1`,
          [a.id],
        );
        expect(queueA.rows[0]!.n).toBe(0);
      } finally {
        await listener.close();
      }
    });
  });

  it('already-due suspend (resumed:true) sends nothing — the slot was kept', async () => {
    await withPg('suspend_notify_resumed', async (ctx) => {
      const { kernel, pool } = ctx;
      const listener = await attachListener(ctx);
      try {
        const { workerId, claims } = await setupKeyedRuns(ctx, {
          limit: 1,
          count: 1,
          claimLimit: 1,
        });
        const a = claims[0]!;

        await drainSetup(listener.received, 1);
        const baseline = listener.received.length;

        const res = await kernel.suspendRun({
          runId: a.id,
          namespace: NS,
          seq: 0,
          kind: 'duration',
          resumeAt: new Date(Date.now() - 60_000).toISOString(),
          workerId,
          fencingToken: a.fencingToken,
        });
        expect(res).toEqual({ resumed: true });

        // Quiet window: a COMMIT-delivered notification lands in milliseconds,
        // so anything left after 400ms is simply not coming.
        await sleep(400);
        expect(listener.received.length).toBe(baseline);

        // The claim was kept — run still running, queue row still held.
        const run = await pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [a.id],
        );
        expect(run.rows[0]!.status).toBe('running');
        const queue = await pool.query<{ n: number; locked_by: string | null }>(
          `SELECT count(*)::int AS n, max(locked_by) AS locked_by FROM queue WHERE run_id = $1`,
          [a.id],
        );
        expect(queue.rows[0]!.n).toBe(1);
        expect(queue.rows[0]!.locked_by).toBe(workerId);
      } finally {
        await listener.close();
      }
    });
  });

  it('suspend of a run WITHOUT a concurrency_key sends nothing', async () => {
    await withPg('suspend_notify_nokey', async (ctx) => {
      const { kernel, pool } = ctx;
      const listener = await attachListener(ctx);
      try {
        // No concurrency limit on the task and no concurrencyKey on the run:
        // runs.concurrency_key stays NULL, so no successor can ever be gated
        // on this run's slot.
        const { workerId } = await kernel.registerWorker({
          codeVersion: 'v1',
          runtime: 'test',
          concurrency: 1,
          namespaces: [NS],
          tasks: [{ id: TASK, codeVersion: 'v1' }],
        });
        const created = await kernel.trigger({ taskId: TASK, payload: {}, namespace: NS });
        const claimed = await kernel.claimRuns({
          workerId,
          namespaces: [NS],
          taskIds: [TASK],
          limit: 1,
          leaseMs: 60_000,
        });
        expect(claimed).toHaveLength(1);
        const a = claimed[0]!;
        expect(a.id).toBe(created.runId);

        await drainSetup(listener.received, 1);
        const baseline = listener.received.length;

        const res = await kernel.suspendRun({
          runId: a.id,
          namespace: NS,
          seq: 0,
          kind: 'duration',
          resumeAt: new Date(Date.now() + 60_000).toISOString(),
          workerId,
          fencingToken: a.fencingToken,
        });
        expect(res).toEqual({ resumed: false });

        await sleep(400);
        expect(listener.received.length).toBe(baseline);

        const run = await pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [a.id],
        );
        expect(run.rows[0]!.status).toBe('waiting');
      } finally {
        await listener.close();
      }
    });
  });

  it('a rejected suspend (run_not_running) rolls back and its notification never lands; fallback intact', async () => {
    await withPg('suspend_notify_rejected', async (ctx) => {
      const { kernel, pool } = ctx;
      const listener = await attachListener(ctx);
      try {
        const { workerId, claims } = await setupKeyedRuns(ctx, {
          limit: 1,
          count: 1,
          claimLimit: 1,
        });
        const a = claims[0]!;

        await drainSetup(listener.received, 1);

        // First suspend succeeds and notifies (the tx committed).
        const first = await kernel.suspendRun({
          runId: a.id,
          namespace: NS,
          seq: 0,
          kind: 'duration',
          resumeAt: new Date(Date.now() + 60_000).toISOString(),
          workerId,
          fencingToken: a.fencingToken,
        });
        expect(first).toEqual({ resumed: false });
        await drainSetup(listener.received, 2);
        const baseline = listener.received.length;

        // A replayed suspend hits the non-running guard inside assertOwnedRunning:
        // the tx rolls back BEFORE any pg_notify was issued, so the listener
        // must see nothing dependent on it.
        await expect(
          kernel.suspendRun({
            runId: a.id,
            namespace: NS,
            seq: 0,
            kind: 'duration',
            resumeAt: new Date(Date.now() + 60_000).toISOString(),
            workerId,
            fencingToken: a.fencingToken,
          }),
        ).rejects.toBeInstanceOf(RunNotRunningError);

        await sleep(400);
        expect(listener.received.length).toBe(baseline);

        // Polling fallback untouched: the run is still 'waiting' with its
        // single pending wait (the rejected pass wrote nothing), and a later
        // legal write path still works — resume the way the orchestrator's
        // wait-due scan would, then the run is claimable again by plain
        // polling (claimRuns), no notification involved.
        const waits = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM waits WHERE run_id = $1 AND status = 'pending'`,
          [a.id],
        );
        expect(waits.rows[0]!.n).toBe(1);
        const run = await pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [a.id],
        );
        expect(run.rows[0]!.status).toBe('waiting');

        await pool.query(
          `UPDATE waits SET status = 'completed' WHERE run_id = $1 AND project_id = $2 AND env = $3`,
          [a.id, NS.projectId, NS.env],
        );
        await pool.query(
          `UPDATE runs SET status = 'queued', updated_at = now() WHERE id = $1 AND project_id = $2 AND env = $3`,
          [a.id, NS.projectId, NS.env],
        );
        const runRow = await pool.query<{ priority: number; concurrency_key: string | null }>(
          `SELECT priority, concurrency_key FROM runs WHERE id = $1`,
          [a.id],
        );
        await pool.query(
          `INSERT INTO queue (run_id, project_id, env, available_at, priority, concurrency_key)
           VALUES ($1, $2, $3, now(), $4, $5)`,
          [a.id, NS.projectId, NS.env, runRow.rows[0]!.priority, runRow.rows[0]!.concurrency_key],
        );
        const reclaimed = await kernel.claimRuns({
          workerId,
          namespaces: [NS],
          taskIds: [TASK],
          limit: 1,
          leaseMs: 60_000,
        });
        expect(reclaimed).toHaveLength(1);
        expect(reclaimed[0]!.id).toBe(a.id);
      } finally {
        await listener.close();
      }
    });
  });

  it('concurrent suspends of several keyed runs deliver ≥1 notification and keep the state machine', async () => {
    await withPg('suspend_notify_concurrent', async (ctx) => {
      const { kernel, pool } = ctx;
      const listener = await attachListener(ctx);
      try {
        // Limit 2: two runs share the slot, a third queues behind them.
        const { workerId, claims, runIds } = await setupKeyedRuns(ctx, {
          limit: 2,
          count: 3,
          claimLimit: 2,
        });
        expect(claims).toHaveLength(2);

        const blocked = await kernel.claimRuns({
          workerId,
          namespaces: [NS],
          taskIds: [TASK],
          limit: 1,
          leaseMs: 60_000,
        });
        expect(blocked).toHaveLength(0);

        await drainSetup(listener.received, 3);
        const baseline = listener.received.length;

        const results = await Promise.all(
          claims.map((c) =>
            kernel.suspendRun({
              runId: c.id,
              namespace: NS,
              seq: 0,
              kind: 'duration',
              resumeAt: new Date(Date.now() + 60_000).toISOString(),
              workerId,
              fencingToken: c.fencingToken,
            }),
          ),
        );
        expect(results).toEqual([{ resumed: false }, { resumed: false }]);

        // Each suspend is its own tx and NOTIFY is per-tx: two successful
        // suspends deliver two notifications. Assert exactly two — one per
        // released slot — rather than a weaker "at least one".
        const msgs = await nextNotifications(listener.received, baseline, 2, 2_000);
        expect(msgs).toHaveLength(2);
        for (const msg of msgs) {
          expect(msg.payload).toEqual({ type: 'work', projectId: NS.projectId, env: NS.env });
        }

        // State machine result unchanged: both waiting, queue rows gone, and
        // the queued successor claimable.
        for (const c of claims) {
          const run = await pool.query<{ status: string }>(
            `SELECT status FROM runs WHERE id = $1`,
            [c.id],
          );
          expect(run.rows[0]!.status).toBe('waiting');
          const queue = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM queue WHERE run_id = $1`,
            [c.id],
          );
          expect(queue.rows[0]!.n).toBe(0);
        }
        const claimedC = await kernel.claimRuns({
          workerId,
          namespaces: [NS],
          taskIds: [TASK],
          limit: 1,
          leaseMs: 60_000,
        });
        expect(claimedC).toHaveLength(1);
        expect(claimedC[0]!.id).toBe(runIds[2]);
      } finally {
        await listener.close();
      }
    });
  });
});
