/* =============================================================================
   @better-trigger/kernel — scheduling timestamps are written on the DATABASE
   clock, not the daemon's (05-T1), against a real Postgres.

   Every scheduler predicate (`available_at <= now()`, `resume_at <= now()`)
   is judged by pg's now(), so a row stamped from a host clock that runs ahead
   of the DB's stays invisible for the whole skew: a fresh run unclaimable, a
   duration wait unresumable, a retry unavailable. The write paths now stamp
   from the DB clock — a `SELECT now()` read inside their own transaction
   (pg's now() is the tx-start timestamp, the very value the claim/wait scans
   compare against) — while absolute instants (wait.until) keep their value.

   The suite reproduces the hazard: the process's `new Date()` is wound FIVE
   MINUTES AHEAD of the database clock (vitest fakes only Date; timers and PG
   stay real, same pattern as cron-skew.test.ts), so every host-clock write
   would land 5 minutes in the DB future — and the assertions prove it did not.
   ============================================================================= */
import { afterEach, expect, it, vi } from 'vitest';
import { describePg, withPg, type PgContext } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const TASK = 'clock-skew-task';
/** How far the process clock is wound AHEAD of the database's. */
const SKEW_MS = 5 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

/** Register one worker serving one task; every scenario starts here. */
async function register(ctx: PgContext): Promise<string> {
  const { workerId } = await ctx.kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: [{ id: TASK, codeVersion: 'v1' }],
  });
  return workerId;
}

/** Trigger TASK and claim its single run (the queue is empty otherwise). */
async function triggerAndClaim(
  ctx: PgContext,
  workerId: string,
): Promise<{ id: string; fencingToken: number }> {
  await ctx.kernel.trigger({ taskId: TASK, payload: {}, namespace: NS });
  const claimed = await ctx.kernel.claimRuns({
    workerId,
    namespaces: [NS],
    taskIds: [TASK],
    limit: 1,
    leaseMs: 60_000,
  });
  expect(claimed).toHaveLength(1);
  return { id: claimed[0]!.id, fencingToken: claimed[0]!.fencingToken };
}

/** Wind the host clock ahead of the DB's: only Date is faked, timers and the
 *  live Postgres keep running on real wall time. */
function skewHostAhead(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.now() + SKEW_MS));
}

describePg('write paths stamp the database clock (05-T1)', () => {
  it('a fresh trigger is claimable at once even with the host clock 5min ahead', async () => {
    await withPg('clock_skew_fresh', async (ctx) => {
      const workerId = await register(ctx);
      const created = await ctx.kernel.trigger({ taskId: TASK, payload: {}, namespace: NS });

      skewHostAhead();
      // The claim scan judges `available_at <= now()` on the DB clock; the
      // trigger's available_at came off the SAME clock, so the run is visible
      // immediately. A host-clock stamp would read +5min and hide the run for
      // the whole skew — this single-shot claim (no retry loop) would see [].
      const claimed = await ctx.kernel.claimRuns({
        workerId,
        namespaces: [NS],
        taskIds: [TASK],
        limit: 1,
        leaseMs: 60_000,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.id).toBe(created.runId);
      // And the DB itself agrees the row is due.
      const due = await ctx.pool.query<{ due: boolean }>(
        `SELECT available_at <= now() AS due FROM queue WHERE run_id = $1`,
        [created.runId],
      );
      expect(due.rows[0]!.due).toBe(true);
    });
  });

  it('a trigger delay lands on the DB clock — due after the delay, not the skew', async () => {
    await withPg('clock_skew_delay', async (ctx) => {
      const workerId = await register(ctx);
      skewHostAhead();

      await ctx.kernel.trigger({
        taskId: TASK,
        payload: {},
        namespace: NS,
        options: { delay: 60_000 },
      });

      // ~1 minute from the DB's now(). A host-clock stamp would sit ~5min+1min
      // out instead.
      const rel = await ctx.pool.query<{ secs: number }>(
        `SELECT extract(epoch FROM (available_at - now()))::float AS secs FROM queue`,
      );
      expect(rel.rows).toHaveLength(1);
      expect(rel.rows[0]!.secs).toBeGreaterThan(55);
      expect(rel.rows[0]!.secs).toBeLessThan(65);

      // Consequence: nothing is claimable yet (the run is genuinely scheduled,
      // not lost), and the scan sees exactly that.
      const claimed = await ctx.kernel.claimRuns({
        workerId,
        namespaces: [NS],
        taskIds: [TASK],
        limit: 1,
        leaseMs: 60_000,
      });
      expect(claimed).toHaveLength(0);
    });
  });

  it('a retry backoff lands on the DB clock', async () => {
    await withPg('clock_skew_retry', async (ctx) => {
      const workerId = await register(ctx);
      // Claim the run BEFORE skewing so only the fail/retry path runs under the
      // skewed host clock.
      const run = await triggerAndClaim(ctx, workerId);

      skewHostAhead();
      const res = await ctx.kernel.failRun({
        runId: run.id,
        error: { message: 'boom' },
        retry: { maxAttempts: 3, baseMs: 60_000, factor: 1, maxMs: 60_000 },
        workerId,
        fencingToken: run.fencingToken,
        namespace: NS,
      });
      expect(res.willRetry).toBe(true);

      // Backoff 60s × 0.8–1.2 jitter, applied to the DB clock: a host-clock
      // stamp would add the +5min skew on top.
      const rel = await ctx.pool.query<{ secs: number }>(
        `SELECT extract(epoch FROM (available_at - now()))::float AS secs FROM queue`,
      );
      expect(rel.rows[0]!.secs).toBeGreaterThan(40);
      expect(rel.rows[0]!.secs).toBeLessThan(80);
    });
  });

  it('a duration suspend re-anchors the remaining time onto the DB clock', async () => {
    await withPg('clock_skew_suspend', async (ctx) => {
      const workerId = await register(ctx);
      const run = await triggerAndClaim(ctx, workerId);

      skewHostAhead();
      // The executor computes resumeAt off its own (skewed) clock: hostNow+30s.
      // The kernel must re-anchor the REMAINING 30s onto the DB clock, not
      // store the skewed absolute instant (which would sit +5min out).
      const resumeAt = new Date(Date.now() + 30_000).toISOString();
      const res = await ctx.kernel.suspendRun({
        runId: run.id,
        namespace: NS,
        seq: 0,
        kind: 'duration',
        resumeAt,
        workerId,
        fencingToken: run.fencingToken,
      });
      expect(res).toEqual({ resumed: false });

      const rel = await ctx.pool.query<{ secs: number }>(
        `SELECT extract(epoch FROM (resume_at - now()))::float AS secs FROM waits`,
      );
      expect(rel.rows[0]!.secs).toBeGreaterThan(25);
      expect(rel.rows[0]!.secs).toBeLessThan(35);
    });
  });

  it('an until suspend keeps the caller-supplied absolute instant verbatim', async () => {
    await withPg('clock_skew_until', async (ctx) => {
      const workerId = await register(ctx);
      const run = await triggerAndClaim(ctx, workerId);

      skewHostAhead();
      // 'until' is an absolute point in time the caller named: it is respected
      // as-is (an absolute instant needs no re-anchoring) — unlike a duration.
      const until = new Date(Date.now() + 30_000).toISOString();
      const res = await ctx.kernel.suspendRun({
        runId: run.id,
        namespace: NS,
        seq: 0,
        kind: 'until',
        resumeAt: until,
        workerId,
        fencingToken: run.fencingToken,
      });
      expect(res).toEqual({ resumed: false });

      const waits = await ctx.pool.query<{ resume_at: Date }>(
        `SELECT resume_at FROM waits WHERE run_id = $1`,
        [run.id],
      );
      expect(waits.rows[0]!.resume_at.toISOString()).toBe(until);
    });
  });
});
