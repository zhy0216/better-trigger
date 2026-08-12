/* =============================================================================
   @better-trigger/kernel — fencing: assertOwnedRunning (todos/p1-22).

   The fenced-write hot path against a real Postgres. The stub suite can assert
   that assertOwnedRunning's SQL *text* orders the two row locks and reads the
   right columns; only a live database can prove the invariant end to end: a
   claim's fencing token actually guards its writes, a bumped token / foreign
   worker / non-running run is refused, and the refusal is atomic with the check
   (no step row lands).

   Every case drives the real kernel API (claimRuns / reportStep / completeRun /
   cancelRun / releaseClaims) and asserts via SQL — SELECT from run_steps, not
   a mocked return.

   The fixture: `claimedRun` registers a worker, triggers a run and claims it,
   so the run is 'running' with a known fencing token. A second claim (after
   releaseClaims) bumps runs.fencing_token — claimRuns is the only writer of it
   (queue.ts) — which is exactly what makes the old token stale.
   ============================================================================= */
import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { RunNotRunningError, StaleLeaseError, type ClaimedRun } from '@better-trigger/core';
import { describePg, withPg, type PgContext } from './helpers';

const NAMESPACE = { projectId: 'default', env: 'prod' };
const TASK = 'fencing-task';

/** Count a run's step rows — the "was anything written?" oracle. */
async function stepCount(pool: Pool, runId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM run_steps WHERE run_id = $1`,
    [runId],
  );
  return Number(res.rows[0]?.n ?? '0');
}

/** Register one worker serving the fencing task. Returns its id. */
async function registerWorker(ctx: PgContext, tag = 'w'): Promise<string> {
  const { workerId } = await ctx.kernel.registerWorker({
    name: tag,
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [NAMESPACE],
    tasks: [{ id: TASK, codeVersion: 'v1' }],
  });
  return workerId;
}

/** Trigger one run of the fencing task. Returns its id. */
async function triggerRun(ctx: PgContext): Promise<string> {
  const { runId } = await ctx.kernel.trigger({
    taskId: TASK,
    payload: { n: 1 },
    namespace: NAMESPACE,
  });
  return runId;
}

/** Claim up to one run for a worker; throws if nothing came back. */
async function claimOne(ctx: PgContext, workerId: string): Promise<ClaimedRun> {
  const claimed = await ctx.kernel.claimRuns({
    workerId,
    namespaces: [NAMESPACE],
    taskIds: [TASK],
    leaseMs: 60_000,
    limit: 1,
  });
  if (claimed.length !== 1) throw new Error('expected exactly one claimed run');
  return claimed[0]!;
}

/** A run in the executing state with its write credential in hand. */
interface ClaimedFixture {
  workerId: string;
  runId: string;
  claim: ClaimedRun;
}

/**
 * The shared fixture: register a worker, trigger a run and claim it. The run
 * is now 'running', owned by `workerId`, guarded by `claim.fencingToken`.
 */
async function claimedRun(ctx: PgContext): Promise<ClaimedFixture> {
  const workerId = await registerWorker(ctx);
  const runId = await triggerRun(ctx);
  const claim = await claimOne(ctx, workerId);
  expect(claim.id).toBe(runId);
  return { workerId, runId, claim };
}

/** A valid completed-step report for a run, under the given credential. */
function stepReport(
  f: { workerId: string; runId: string },
  seq: number,
  fencingToken: number,
) {
  return {
    runId: f.runId,
    namespace: NAMESPACE,
    seq,
    kind: 'step' as const,
    status: 'completed' as const,
    output: { ok: true },
    attempt: 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    workerId: f.workerId,
    fencingToken,
  };
}

describePg('fencing — assertOwnedRunning', () => {
  it('a claim can report a step on its own run', async () => {
    await withPg('fencing', async (ctx) => {
      const f = await claimedRun(ctx);

      await ctx.kernel.reportStep(stepReport(f, 1, f.claim.fencingToken));

      expect(await stepCount(ctx.pool, f.runId)).toBe(1);
    });
  });

  it('a stale fencing token is rejected and writes nothing', async () => {
    await withPg('fencing', async (ctx) => {
      const f = await claimedRun(ctx);
      const t1 = f.claim.fencingToken;

      // A second claim (only claimRuns bumps the token) invalidates the first.
      await ctx.kernel.releaseClaims({ workerId: f.workerId, namespaces: [NAMESPACE] });
      const re = await claimOne(ctx, f.workerId);
      expect(re.fencingToken).toBeGreaterThan(t1);

      await expect(
        ctx.kernel.reportStep(stepReport(f, 1, t1)),
      ).rejects.toThrow(StaleLeaseError);
      await expect(
        ctx.kernel.completeRun({
          runId: f.runId,
          output: { ok: true },
          workerId: f.workerId,
          fencingToken: t1,
          namespace: NAMESPACE,
        }),
      ).rejects.toThrow(StaleLeaseError);

      expect(await stepCount(ctx.pool, f.runId)).toBe(0);
    });
  });

  it('a foreign workerId is rejected even with a matching token', async () => {
    await withPg('fencing', async (ctx) => {
      const a = await claimedRun(ctx);
      const b = await registerWorker(ctx, 'w-b');

      // Owner is worker A (queue.locked_by = a), so locked_by !== workerId wins
      // the fence even though the token would match.
      await expect(
        ctx.kernel.reportStep({
          ...stepReport(a, 1, a.claim.fencingToken),
          workerId: b,
        }),
      ).rejects.toMatchObject({ code: 'stale_lease' });
      await expect(
        ctx.kernel.completeRun({
          runId: a.runId,
          output: { ok: true },
          workerId: b,
          fencingToken: a.claim.fencingToken,
          namespace: NAMESPACE,
        }),
      ).rejects.toThrow(StaleLeaseError);

      expect(await stepCount(ctx.pool, a.runId)).toBe(0);
    });
  });

  it('a non-running run is rejected (queued and terminal)', async () => {
    await withPg('fencing', async (ctx) => {
      // Claimed then completed → 'completed' is equally unwritable. Built first
      // so no queued run lingers to be picked up by the fixture's claim.
      const f = await claimedRun(ctx);
      await ctx.kernel.completeRun({
        runId: f.runId,
        output: { ok: true },
        workerId: f.workerId,
        fencingToken: f.claim.fencingToken,
        namespace: NAMESPACE,
      });
      await expect(
        ctx.kernel.reportStep(stepReport(f, 1, f.claim.fencingToken)),
      ).rejects.toThrow(RunNotRunningError);
      await expect(
        ctx.kernel.completeRun({
          runId: f.runId,
          output: { ok: true },
          workerId: f.workerId,
          fencingToken: f.claim.fencingToken,
          namespace: NAMESPACE,
        }),
      ).rejects.toThrow(RunNotRunningError);
      expect(await stepCount(ctx.pool, f.runId)).toBe(0);

      // Never claimed → still 'queued'.
      const queuedRunId = await triggerRun(ctx);
      await expect(
        ctx.kernel.reportStep(
          stepReport({ workerId: f.workerId, runId: queuedRunId }, 1, 0),
        ),
      ).rejects.toThrow(RunNotRunningError);
      expect(await stepCount(ctx.pool, queuedRunId)).toBe(0);
    });
  });

  it('a reaped claim cannot write (release → reclaim invalidates the old token)', async () => {
    await withPg('fencing', async (ctx) => {
      const f = await claimedRun(ctx);
      const t1 = f.claim.fencingToken;

      await ctx.kernel.releaseClaims({ workerId: f.workerId, namespaces: [NAMESPACE] });
      const re = await claimOne(ctx, f.workerId);

      // The old claim's credential is dead on arrival...
      await expect(
        ctx.kernel.reportStep(stepReport(f, 1, t1)),
      ).rejects.toThrow(StaleLeaseError);
      expect(await stepCount(ctx.pool, f.runId)).toBe(0);

      // ...while the fresh claim's token writes normally.
      await ctx.kernel.reportStep(
        stepReport({ workerId: f.workerId, runId: f.runId }, 1, re.fencingToken),
      );
      expect(await stepCount(ctx.pool, f.runId)).toBe(1);
    });
  });
});
