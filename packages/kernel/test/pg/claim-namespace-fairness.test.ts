/* =============================================================================
   @better-trigger/kernel — namespace claim fairness on a real Postgres (P0-14).

   The stub suite (claim-rotation.test.ts) pins the rotation mechanics against
   canned rows; this proves the property that actually matters end to end:
   with a permanently busy namespaces[0] (≥ 2×limit claimable runs), a run in
   namespaces[1] is still CLAIMED within a bounded number of rounds once the
   caller rotates the scan start — and, as the contrast that names the bug,
   the same backlog leaves namespaces[1] untouched while every call scans in
   array order.

   Real claims, real leases: every round goes through claimRuns' FOR UPDATE
   SKIP LOCKED scan, the runs flip and the lease write, and "was it claimed"
   is read back from runs.status, not from a mock.

   Skipped unless DATABASE_URL is set (see helpers.ts).
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Namespace } from '@better-trigger/core';
import { describePg, withPg, type PgContext } from './helpers';

const NS_A: Namespace = { projectId: 'acme', env: 'staging' };
const NS_B: Namespace = { projectId: 'acme', env: 'prod' };
const TASK = 'fairness-task';

async function triggerRuns(
  ctx: PgContext,
  namespace: Namespace,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await ctx.kernel.trigger({ taskId: TASK, payload: { i }, namespace });
  }
}

describePg('claim namespace fairness (P0-14)', () => {
  it('a busy namespaces[0] cannot starve namespaces[1] under rotation', async () => {
    await withPg('claim_namespace_fairness', async (ctx) => {
      const { workerId } = await ctx.kernel.registerWorker({
        name: 'w',
        codeVersion: 'v1',
        runtime: 'test',
        concurrency: 1,
        namespaces: [NS_A, NS_B],
        tasks: [{ id: TASK, codeVersion: 'v1' }],
      });
      // ns A carries ≥ 2×limit backlog; ns B just one run. limit is 1 per
      // round, like every worker slot.
      await triggerRuns(ctx, NS_A, 4);
      await triggerRuns(ctx, NS_B, 1);

      const skippedTails: Namespace[][] = [];
      const claimedEnvs: string[] = [];
      for (let turn = 0; turn < 2; turn += 1) {
        const claimed = await ctx.kernel.claimRuns({
          workerId,
          namespaces: [NS_A, NS_B],
          taskIds: [TASK],
          limit: 1,
          leaseMs: 60_000,
          rotateFrom: turn % 2,
          onScanSkipped: (s) => skippedTails.push([...s]),
        });
        for (const c of claimed) claimedEnvs.push(c.env);
      }
      // Round 1 leads with A, round 2 leads with B — B's single run is claimed
      // by the second round no matter how deep A's backlog is.
      expect(claimedEnvs).toEqual(['staging', 'prod']);
      // The skip that rotation bounds: each claimed round reported the other
      // namespace as never scanned.
      expect(skippedTails).toEqual([[NS_B], [NS_A]]);

      // Contrast, the pre-P0-14 behaviour itself: without rotateFrom the same
      // shape of backlog starves B for every one of the rounds.
      await triggerRuns(ctx, NS_A, 4);
      await triggerRuns(ctx, NS_B, 1);
      const unrotated: string[] = [];
      for (let turn = 0; turn < 3; turn += 1) {
        const claimed = await ctx.kernel.claimRuns({
          workerId,
          namespaces: [NS_A, NS_B],
          taskIds: [TASK],
          limit: 1,
          leaseMs: 60_000,
        });
        for (const c of claimed) unrotated.push(c.env);
      }
      expect(unrotated).toEqual(['staging', 'staging', 'staging']);

      // And B is still queued — starved, not claimed, not lost.
      const stillQueued = await ctx.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM runs
          WHERE task_id = $1 AND project_id = $2 AND env = $3 AND status = 'queued'`,
        [TASK, NS_B.projectId, NS_B.env],
      );
      expect(Number(stillQueued.rows[0]!.n)).toBe(1);
    });
  });
});
