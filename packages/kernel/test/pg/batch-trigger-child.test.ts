/* =============================================================================
   @better-trigger/kernel — 04-T3 against a real Postgres: fan-out from inside
   a task leaves no unclaimable orphans.

   batchTriggerChild used to create children with requireTask:false — a batch
   item naming an unregistered task produced a run no worker can ever claim
   (task rows only exist once some worker registered the task). Worse, those
   runs carry code_version NULL, which the stranded-run scan filters out, so
   the orphans piled up in the queue invisible to every metric and alert.
   triggerAndWait chose requireTask:true for exactly this reason; the fan-out
   now does too: TaskNotFoundError inside the tx → the whole batch rolls back
   (all-or-nothing, like the client-side batchTrigger) and the executor turns
   task_not_found into a non-retryable failure.
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import { TaskNotFoundError } from '../../src/index';
import { describePg, withPg, type PgContext } from './helpers';

const NS = { projectId: 'default', env: 'prod' };

/** The worker-side view of a claim (same shape as trigger-and-wait.test.ts). */
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

async function countRuns(pool: Pool, taskId: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM runs WHERE task_id = $1`,
    [taskId],
  );
  return res.rows[0]!.n;
}

describePg('batchTriggerChild requireTask (04-T3)', () => {
  it('an unregistered item fails the whole fan-out with task_not_found and creates nothing', async () => {
    await withPg('fanout_unregistered', async (ctx) => {
      const { kernel, pool } = ctx;
      // Only the PARENT task is registered — 'ghost-task' has no task row, so
      // no worker could ever claim a run of it.
      const { workerId, fencingToken, runId } = await claimedRun(
        ctx,
        [{ id: 'fanout-parent', codeVersion: 'v1' }],
        'fanout-parent',
      );

      const err = await kernel
        .batchTriggerChild({
          runId,
          namespace: NS,
          seq: 0,
          label: 'fan',
          items: [{ taskId: 'ghost-task', payload: null }],
          workerId,
          fencingToken,
        })
        .then(
          () => {
            throw new Error('batchTriggerChild should have rejected');
          },
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(TaskNotFoundError);
      expect(err).toMatchObject({ code: 'task_not_found' });

      // No orphan run for the unregistered task...
      expect(await countRuns(pool, 'ghost-task')).toBe(0);
      // ...no step row recorded for the fan-out...
      const steps = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM run_steps WHERE run_id = $1`,
        [runId],
      );
      expect(steps.rows[0]!.n).toBe(0);
      // ...and the parent stays exactly where it was: running, claim held.
      const run = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [
        runId,
      ]);
      expect(run.rows[0]!.status).toBe('running');
      const queue = await pool.query<{ locked_by: string | null }>(
        `SELECT locked_by FROM queue WHERE run_id = $1`,
        [runId],
      );
      expect(queue.rows[0]!.locked_by).toBe(workerId);
    });
  });

  it('one unregistered item rolls back the WHOLE batch (all-or-nothing)', async () => {
    await withPg('fanout_mixed', async (ctx) => {
      const { kernel, pool } = ctx;
      // The valid child IS registered — but a batch is one transaction, so the
      // ghost item must sink its sibling too instead of leaving a half fan-out.
      const { workerId, fencingToken, runId } = await claimedRun(
        ctx,
        [
          { id: 'fanout-parent', codeVersion: 'v1' },
          { id: 'fanout-child', codeVersion: 'v1' },
        ],
        'fanout-parent',
      );

      await expect(
        kernel.batchTriggerChild({
          runId,
          namespace: NS,
          seq: 0,
          label: 'fan',
          items: [
            { taskId: 'fanout-child', payload: null },
            { taskId: 'ghost-task', payload: null },
          ],
          workerId,
          fencingToken,
        }),
      ).rejects.toMatchObject({ code: 'task_not_found' });

      expect(await countRuns(pool, 'fanout-child')).toBe(0);
      expect(await countRuns(pool, 'ghost-task')).toBe(0);
    });
  });

  it('a legitimate fan-out still creates every child (no regression)', async () => {
    await withPg('fanout_ok', async (ctx) => {
      const { kernel, pool } = ctx;
      const { workerId, fencingToken, runId } = await claimedRun(
        ctx,
        [
          { id: 'fanout-parent', codeVersion: 'v1' },
          { id: 'fanout-child', codeVersion: 'v1' },
        ],
        'fanout-parent',
      );

      const res = await kernel.batchTriggerChild({
        runId,
        namespace: NS,
        seq: 0,
        label: 'fan',
        items: [
          { taskId: 'fanout-child', payload: { n: 1 } },
          { taskId: 'fanout-child', payload: { n: 2 } },
        ],
        workerId,
        fencingToken,
      });
      expect(res.runIds).toHaveLength(2);

      const children = await pool.query<{
        id: string;
        parent_run_id: string | null;
        trigger_type: string;
        status: string;
        code_version: string | null;
      }>(
        `SELECT id, parent_run_id, trigger_type, status, code_version
           FROM runs WHERE task_id = $1 ORDER BY created_at`,
        ['fanout-child'],
      );
      expect(children.rows).toHaveLength(2);
      for (const row of children.rows) {
        expect(row.parent_run_id).toBe(runId);
        expect(row.trigger_type).toBe('subtask');
        expect(row.status).toBe('queued');
        // The task row exists, so the run carries a real version — exactly the
        // property the stranded scan needs to keep seeing these runs.
        expect(row.code_version).toBe('v1');
      }
      expect(res.runIds).toEqual(children.rows.map((r) => r.id));

      // The durable step row recorded the fan-out.
      const step = await pool.query<{ kind: string; status: string }>(
        `SELECT kind, status FROM run_steps WHERE run_id = $1 AND seq = 0`,
        [runId],
      );
      expect(step.rows).toEqual([{ kind: 'batch-trigger', status: 'completed' }]);
    });
  });
});
