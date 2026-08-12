/* =============================================================================
   @better-trigger/kernel — trigger-and-wait against a real Postgres.

   waitForChildRun and retryRun both route the child / retry run through
   createRunIn with `requireTask: true`, so an unregistered task id must raise
   TaskNotFoundError (code 'task_not_found') INSIDE the transaction — and,
   because the throw happens mid-transaction, the whole mutation set (waits
   row, parent status flip to 'waiting', queue-row removal) must roll back
   atomically rather than leaving a half-suspended parent. retryRun has the
   same property: a task row that vanished after the run went terminal must
   404 and enqueue nothing. This suite asserts both, against real Postgres.
   ============================================================================= */
import { expect, it } from 'vitest';
import { describePg, withPg, type PgContext } from './helpers';
import { TaskNotFoundError } from '../../src/index';

const NS = { projectId: 'default', env: 'prod' };

/** The worker-side view of a claim (mirrors the suspend suite's `claimedRun`). */
interface Claim {
  workerId: string;
  fencingToken: number;
  runId: string;
}

/** Register `tasks`, trigger `triggerTask`, claim it, and return the claim. */
async function claimedRun(
  ctx: PgContext,
  tasks: { id: string; codeVersion: string }[],
  triggerTask: string,
): Promise<Claim> {
  const { kernel } = ctx;
  const { workerId } = await kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks,
  });

  await kernel.trigger({ taskId: triggerTask, payload: {}, namespace: NS });

  const claimed = await kernel.claimRuns({
    workerId,
    namespaces: [NS],
    taskIds: [triggerTask],
    limit: 1,
    leaseMs: 60_000,
  });
  expect(claimed).toHaveLength(1);
  const c = claimed[0]!;
  return { workerId, fencingToken: c.fencingToken, runId: c.id };
}

describePg('trigger-and-wait atomicity', () => {
  it('waitForChildRun with an unregistered taskId throws task_not_found and rolls back atomically', async () => {
    await withPg('trigger_wait_unregistered', async (ctx) => {
      const { kernel, pool } = ctx;
      // Only the PARENT task is registered — 'typo-task' does not exist.
      const { workerId, fencingToken, runId } = await claimedRun(
        ctx,
        [{ id: 'trigger-wait-parent', codeVersion: 'v1' }],
        'trigger-wait-parent',
      );

      const err = await kernel
        .waitForChildRun({
          runId,
          namespace: NS,
          seq: 0,
          taskId: 'typo-task',
          payload: {},
          label: 'spawn missing child',
          fingerprint: 'fp-x',
          workerId,
          fencingToken,
        })
        .then(
          () => {
            throw new Error('waitForChildRun should have rejected');
          },
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(TaskNotFoundError);
      expect(err).toMatchObject({ code: 'task_not_found' });

      // The whole transaction rolled back: the parent never suspended...
      const run = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId]);
      expect(run.rows[0]!.status).toBe('running');

      // ...no wait was ever written...
      const waits = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM waits WHERE run_id = $1`,
        [runId],
      );
      expect(waits.rows[0]!.n).toBe(0);

      // ...no child run was created for the typo'd task...
      const childRuns = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs WHERE task_id = $1`,
        ['typo-task'],
      );
      expect(childRuns.rows[0]!.n).toBe(0);

      // ...and the parent's queue row is still there, still claimed by us.
      const queue = await pool.query<{ n: number; locked_by: string | null }>(
        `SELECT count(*)::int AS n, max(locked_by) AS locked_by FROM queue WHERE run_id = $1`,
        [runId],
      );
      expect(queue.rows[0]!.n).toBe(1);
      expect(queue.rows[0]!.locked_by).toBe(workerId);
    });
  });

  it('waitForChildRun with a registered taskId still works (no regression)', async () => {
    await withPg('trigger_wait_registered', async (ctx) => {
      const { kernel, pool } = ctx;
      const { workerId, fencingToken, runId } = await claimedRun(
        ctx,
        [
          { id: 'trigger-wait-parent', codeVersion: 'v1' },
          { id: 'trigger-wait-child', codeVersion: 'v1' },
        ],
        'trigger-wait-parent',
      );

      const payload = { n: 42 };
      const res = await kernel.waitForChildRun({
        runId,
        namespace: NS,
        seq: 0,
        label: 'spawn child',
        taskId: 'trigger-wait-child',
        payload,
        fingerprint: 'fp-ok',
        workerId,
        fencingToken,
      });

      const child = await pool.query<{
        parent_run_id: string | null;
        trigger_type: string;
        status: string;
      }>(`SELECT parent_run_id, trigger_type, status FROM runs WHERE id = $1`, [res.childRunId]);
      expect(child.rows).toHaveLength(1);
      expect(child.rows[0]!.parent_run_id).toBe(runId);
      expect(child.rows[0]!.trigger_type).toBe('subtask');
      expect(child.rows[0]!.status).toBe('queued');

      const parent = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId]);
      expect(parent.rows[0]!.status).toBe('waiting');
    });
  });

  it('retryRun of a run whose task is no longer registered throws task_not_found and enqueues nothing', async () => {
    await withPg('retry_unregistered', async (ctx) => {
      const { kernel, pool } = ctx;
      // Register the task, trigger, claim, then cancel the claimed run so it
      // goes terminal 'canceled' (retryRun only retries failed/canceled runs).
      const { runId } = await claimedRun(
        ctx,
        [{ id: 'gone-task', codeVersion: 'v1' }],
        'gone-task',
      );
      await kernel.cancelRun(runId, NS);

      const canceled = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId]);
      expect(canceled.rows[0]!.status).toBe('canceled');

      // Simulate the task no longer being registered by deleting its task row.
      await pool.query(`DELETE FROM tasks WHERE id = $1 AND project_id = $2 AND env = $3`, [
        'gone-task',
        NS.projectId,
        NS.env,
      ]);
      const tasksLeft = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tasks WHERE id = $1`,
        ['gone-task'],
      );
      expect(tasksLeft.rows[0]!.n).toBe(0);

      const queueBefore = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM queue`);
      const runsBefore = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM runs`);

      const err = await kernel.retryRun(runId, NS).then(
        () => {
          throw new Error('retryRun should have rejected');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TaskNotFoundError);
      expect(err).toMatchObject({ code: 'task_not_found' });

      // Nothing was enqueued and no new run row landed for the vanished task.
      const queueAfter = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM queue`);
      const runsAfter = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM runs`);
      expect(queueAfter.rows[0]!.n).toBe(queueBefore.rows[0]!.n);
      expect(runsAfter.rows[0]!.n).toBe(runsBefore.rows[0]!.n);
    });
  });
});
