/* =============================================================================
   @better-trigger/kernel — maxSteps ledger cap on claim (p1-07).

   claimRuns reads each claimed run's step ledger OUTSIDE the claim transaction
   (p1-07) and, when `maxSteps` is set, reads maxSteps + 1 rows so an overflow is
   visible without a second count. A run whose ledger exceeds the cap is still
   claimed — lease taken, run flipped to 'running', fencing token bumped — but is
   marked `stepsTruncated` with steps trimmed to the cap: the executor must fail
   it non-retryably rather than replay a ledger it could not fully see.

   This suite plants fat ledgers directly via SQL (INSERT ... generate_series)
   and asserts the truncation contract end to end against a real Postgres:

     - a 12,000-step ledger claimed with maxSteps 10,000 comes back truncated
       (steps.length === 10,000, stepsTruncated === true, seqs still start at 0);
     - the same ledger claimed WITHOUT a cap comes back whole (12,000 steps,
       no stepsTruncated flag);
     - a small (5-step) ledger is untouched by the cap.

   Pre-fix there was no cap at all: the ledger was read inside the locked claim
   transaction and shipped whole, so a run with 12,000 steps came back with all
   12,000 steps — and held the claim window's FOR UPDATE SKIP LOCKED rows for the
   whole materialization. Case 1 below is the regression: it must truncate.
   ============================================================================= */
import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { describePg, withPg, type PgContext } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const TASK = 'ledger-cap-task';
const MAX_STEPS = 10_000;
const FAT_STEPS = 12_000;

/** A worker + one queued run of the ledger-cap task. */
async function seedRun(ctx: PgContext): Promise<{ workerId: string; runId: string }> {
  const { workerId } = await ctx.kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: [{ id: TASK, codeVersion: 'v1' }],
  });
  const { runId } = await ctx.kernel.trigger({
    taskId: TASK,
    payload: { n: 1 },
    namespace: NS,
  });
  return { workerId, runId };
}

/** Plant `count` completed run_steps rows with a contiguous seq 0..count-1. */
async function insertSteps(pool: Pool, runId: string, count: number): Promise<void> {
  await pool.query(
    `INSERT INTO run_steps (run_id, seq, project_id, env, kind, label, status, output, error, attempt, started_at, finished_at, fingerprint)
     SELECT $1, g, $2, $3, 'step', 's', 'completed', NULL, NULL, 1, now(), now(), NULL
       FROM generate_series(0, $4 - 1) AS g`,
    [runId, NS.projectId, NS.env, count],
  );
}

describePg('maxSteps ledger cap', () => {
  it('a ledger past maxSteps is claimed with stepsTruncated and trimmed to the cap', async () => {
    await withPg('ledger_cap_truncated', async (ctx) => {
      const { kernel, pool } = ctx;
      const { workerId, runId } = await seedRun(ctx);
      await insertSteps(pool, runId, FAT_STEPS);

      const claimed = await kernel.claimRuns({
        workerId,
        namespaces: [NS],
        taskIds: [TASK],
        limit: 1,
        leaseMs: 60_000,
        maxSteps: MAX_STEPS,
      });
      expect(claimed).toHaveLength(1);
      const run = claimed[0]!;
      expect(run.id).toBe(runId);
      expect(run.stepsTruncated).toBe(true);
      expect(run.steps).toHaveLength(MAX_STEPS);
      // Trimmed to the cap, not the tail — replay would otherwise skip steps.
      expect(run.steps[0]!.seq).toBe(0);
      expect(run.steps[MAX_STEPS - 1]!.seq).toBe(MAX_STEPS - 1);
      for (let i = 1; i < run.steps.length; i++) {
        expect(run.steps[i]!.seq).toBe(run.steps[i - 1]!.seq + 1);
      }

      // The truncation is a claim flag, not a claim escape: the run went
      // 'running', its fencing token was bumped, and the queue row is locked.
      const runRow = await pool.query<{ status: string; fencing_token: string }>(
        `SELECT status, fencing_token FROM runs WHERE id = $1`,
        [runId],
      );
      expect(runRow.rows[0]!.status).toBe('running');
      expect(Number(runRow.rows[0]!.fencing_token)).toBe(1);

      const queue = await pool.query<{
        locked_by: string | null;
        locked_at: Date | null;
        lease_until: Date | null;
      }>(`SELECT locked_by, locked_at, lease_until FROM queue WHERE run_id = $1`, [runId]);
      expect(queue.rows[0]!.locked_by).toBe(workerId);
      expect(queue.rows[0]!.locked_at).not.toBeNull();
      expect(queue.rows[0]!.lease_until).not.toBeNull();

      // The ledger itself is intact — the cap only trims the claimed snapshot.
      const full = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM run_steps WHERE run_id = $1`,
        [runId],
      );
      expect(Number(full.rows[0]!.n)).toBe(FAT_STEPS);
    });
  });

  it('the same ledger claimed without maxSteps ships whole with no truncation', async () => {
    await withPg('ledger_cap_full', async (ctx) => {
      const { kernel, pool } = ctx;
      const { workerId, runId } = await seedRun(ctx);
      await insertSteps(pool, runId, FAT_STEPS);

      const claimed = await kernel.claimRuns({
        workerId,
        namespaces: [NS],
        taskIds: [TASK],
        limit: 1,
        leaseMs: 60_000,
      });
      expect(claimed).toHaveLength(1);
      const run = claimed[0]!;
      expect(run.id).toBe(runId);
      expect(run.stepsTruncated).toBeUndefined();
      expect(run.steps).toHaveLength(FAT_STEPS);
      expect(run.steps[0]!.seq).toBe(0);
      expect(run.steps[FAT_STEPS - 1]!.seq).toBe(FAT_STEPS - 1);
    });
  });

  it('a small ledger is untouched by the cap', async () => {
    await withPg('ledger_cap_small', async (ctx) => {
      const { kernel, pool } = ctx;
      const { workerId, runId } = await seedRun(ctx);
      await insertSteps(pool, runId, 5);

      const claimed = await kernel.claimRuns({
        workerId,
        namespaces: [NS],
        taskIds: [TASK],
        limit: 1,
        leaseMs: 60_000,
        maxSteps: MAX_STEPS,
      });
      expect(claimed).toHaveLength(1);
      const run = claimed[0]!;
      expect(run.id).toBe(runId);
      expect(run.stepsTruncated).toBeUndefined();
      expect(run.steps).toHaveLength(5);
      expect(run.steps[0]!.seq).toBe(0);
      expect(run.steps[4]!.seq).toBe(4);
    });
  });
});
