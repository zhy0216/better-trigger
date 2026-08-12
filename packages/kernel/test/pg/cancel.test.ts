/* =============================================================================
   @better-trigger/kernel — cancelRun against a real Postgres (todos/p1-22).

   cancelRun terminates a non-terminal run: flips runs.status to 'canceled' with
   finished_at + updated_at, deletes the queue row, and marks any pending waits
   'canceled'. A terminal run (completed/failed/canceled) is a no-op — the tx
   early-returns before any mutation. A missing run throws not_found.

   Lock order is the canonical queue → runs (see runs.ts header): cancelRun
   takes the run's queue row FOR UPDATE first, then the runs row, so a cancel
   issued while another transaction holds the queue-row lock (a claim in
   flight) blocks until that transaction commits or rolls back.

   These four cases assert that semantics end to end against the real engine:
     queued → canceled, terminal → untouched no-op, waiting → waits cleaned,
     and the cancel-vs-claim lock ordering with a second real connection.
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Kernel } from '../../src';
import type { ClaimedRun } from '@better-trigger/core';
import { describePg, withPg } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const TASK = 'cancel-task';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Register a worker + task and create one 'api' run; returns the run id. */
async function seedQueued(kernel: Kernel, taskId = TASK): Promise<string> {
  await kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: [{ id: taskId, codeVersion: 'v1' }],
  });
  const created = await kernel.trigger({ taskId, payload: { n: 1 }, namespace: NS });
  return created.runId;
}

/** Claim `runId` for worker 'w1' and return the claim. */
async function claimRun(kernel: Kernel, runId: string, taskId = TASK): Promise<ClaimedRun> {
  const claimed = await kernel.claimRuns({
    workerId: 'w1',
    namespaces: [NS],
    taskIds: [taskId],
    limit: 1,
    leaseMs: 60_000,
  });
  const run = claimed.find((c) => c.id === runId);
  if (!run) throw new Error(`run ${runId} was not claimed`);
  return run;
}

async function runRow(pool: import('pg').Pool, runId: string) {
  const res = await pool.query<{
    status: string;
    finished_at: Date | null;
    updated_at: Date;
  }>(`SELECT status, finished_at, updated_at FROM runs WHERE id = $1`, [runId]);
  return res.rows[0];
}

async function queueCount(pool: import('pg').Pool, runId: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM queue WHERE run_id = $1`,
    [runId],
  );
  return res.rows[0].n;
}

describePg('cancelRun', () => {
  it('cancels a queued run: canceled status, queue row gone, getRun agrees', async () => {
    await withPg('cancel', async ({ kernel, pool }) => {
      const runId = await seedQueued(kernel);
      expect((await runRow(pool, runId)).status).toBe('queued');
      expect(await queueCount(pool, runId)).toBe(1);

      await kernel.cancelRun(runId, NS);

      expect((await runRow(pool, runId)).status).toBe('canceled');
      expect(await queueCount(pool, runId)).toBe(0);
      expect((await kernel.getRun(runId, NS)).status).toBe('canceled');
    });
  });

  it('is a no-op on a terminal run: completed stays completed, nothing changes', async () => {
    await withPg('cancel', async ({ kernel, pool }) => {
      const runId = await seedQueued(kernel);
      const claim = await claimRun(kernel, runId);
      await kernel.completeRun({
        runId,
        output: { ok: true },
        workerId: 'w1',
        fencingToken: claim.fencingToken,
        namespace: NS,
      });
      const before = await runRow(pool, runId);
      expect(before.status).toBe('completed');
      expect(before.finished_at).not.toBeNull();
      expect(await queueCount(pool, runId)).toBe(0);

      await kernel.cancelRun(runId, NS);

      const after = await runRow(pool, runId);
      expect(after.status).toBe('completed');
      expect(after.finished_at?.toISOString()).toBe(before.finished_at?.toISOString());
      expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
      expect(await queueCount(pool, runId)).toBe(0);
      expect((await kernel.getRun(runId, NS)).status).toBe('completed');
    });
  });

  it('cleans up a waiting run: pending wait flips to canceled, queue stays empty', async () => {
    await withPg('cancel', async ({ kernel, pool }) => {
      const runId = await seedQueued(kernel);
      const claim = await claimRun(kernel, runId);
      const suspended = await kernel.suspendRun({
        runId,
        namespace: NS,
        seq: 0,
        label: 'wait',
        kind: 'duration',
        resumeAt: new Date(Date.now() + 60_000).toISOString(),
        workerId: 'w1',
        fencingToken: claim.fencingToken,
      });
      expect(suspended.resumed).toBe(false);

      const waits = await pool.query<{ status: string }>(
        `SELECT status FROM waits WHERE run_id = $1`,
        [runId],
      );
      expect(waits.rows).toEqual([{ status: 'pending' }]);
      expect((await runRow(pool, runId)).status).toBe('waiting');
      expect(await queueCount(pool, runId)).toBe(0);

      await kernel.cancelRun(runId, NS);

      const waitsAfter = await pool.query<{ status: string }>(
        `SELECT status FROM waits WHERE run_id = $1`,
        [runId],
      );
      expect(waitsAfter.rows).toEqual([{ status: 'canceled' }]);
      expect((await runRow(pool, runId)).status).toBe('canceled');
      expect(await queueCount(pool, runId)).toBe(0);
      expect((await kernel.getRun(runId, NS)).status).toBe('canceled');
    });
  });

  it('blocks on a concurrent claim holding the queue row, then proceeds on rollback', async () => {
    await withPg('cancel', async ({ kernel, pool }) => {
      const runId = await seedQueued(kernel);

      // A claim transaction in flight: hold the run's queue row FOR UPDATE on a
      // dedicated connection — the exact position-1 lock cancelRun's tx takes
      // first (see runs.ts header).
      const claimClient = await pool.connect();
      try {
        await claimClient.query('BEGIN');
        await claimClient.query(
          `SELECT locked_by FROM queue WHERE run_id = $1 AND project_id = $2 AND env = $3 FOR UPDATE`,
          [runId, NS.projectId, NS.env],
        );

        let settled: 'blocked' | 'done' = 'blocked';
        const cancelP = kernel.cancelRun(runId, NS).then(() => {
          settled = 'done';
        });

        // Genuinely blocked: it has not resolved within the race window, and a
        // live backend is sitting on a Lock wait against the queue row.
        const race = await Promise.race([
          cancelP.then(() => 'done' as const),
          sleep(300).then(() => 'blocked' as const),
        ]);
        expect(race).toBe('blocked');
        const waiters = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%FROM queue%'`,
        );
        expect(waiters.rows[0].n).toBeGreaterThan(0);
        expect(settled).toBe('blocked');
        expect((await runRow(pool, runId)).status).toBe('queued');

        // The claim lets go without committing anything → cancel proceeds.
        await claimClient.query('ROLLBACK');
        await cancelP;
        expect(settled).toBe('done');
      } finally {
        claimClient.release();
      }

      expect((await runRow(pool, runId)).status).toBe('canceled');
      expect(await queueCount(pool, runId)).toBe(0);
    });
  });
});
