/* =============================================================================
   @better-trigger/kernel — p2-18 C1 against a real Postgres: the schedule of a
   task no online worker serves stops creating runs, and starts again the
   moment a serving worker comes back.

   The stub suite (test/cron-unserved.test.ts) pins which path a due row takes;
   only real SQL can prove the "served" check actually reads the workers
   jsonb (pair AND legacy manifest shapes, namespace containment, the online
   + heartbeat window) and that the skip's write-back really advances the
   schedule so it re-fires cleanly once someone serves the task again.
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Kernel } from '../../src/index';
import { describePg, withPg } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const CRON_TASK = 'ghost-cron';
/** Never naturally due (once a year): every fire in these tests is a
 *  forceDue(), so there is no minute-boundary race between the phases. */
const CRON_PATTERN = '0 0 1 1 *';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function countScheduleRuns(pool: Pool): Promise<number> {
  const res = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM runs WHERE task_id = $1 AND trigger_type = 'schedule'`,
    [CRON_TASK],
  );
  return res.rows[0]!.count;
}

async function registerCronWorker(kernel: Kernel): Promise<string> {
  const { workerId } = await kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: [{ id: CRON_TASK, codeVersion: 'v1', cron: { pattern: CRON_PATTERN } }],
  });
  return workerId;
}

/** Make the schedule overdue so the next tick finds it due. */
async function forceDue(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE schedules SET next_run_at = now() - interval '5 minutes' WHERE task_id = $1`,
    [CRON_TASK],
  );
}

async function waitForFirstRun(pool: Pool, atLeast: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await countScheduleRuns(pool)) < atLeast) {
    if (Date.now() > deadline) throw new Error(`schedule never produced run #${atLeast}`);
    await sleep(50);
  }
}

describePg('cron skip of unserved schedules (p2-18 C1)', () => {
  it('creates no run while nothing serves the task, and resumes when a worker returns', async () => {
    await withPg('cron_unserved', async ({ kernel, pool }) => {
      await registerCronWorker(kernel);

      const handle = kernel.startOrchestrator({
        cron: true,
        waits: false,
        reaper: false,
        workerOffline: false, // my manual status flips must not be re-marked
        cronIntervalMs: 100,
        namespaces: [NS],
      });
      try {
        // Served (worker just registered, online, fresh heartbeat): fires.
        await forceDue(pool);
        await waitForFirstRun(pool, 1);
        const fired = await pool.query<{ last_run_id: string | null }>(
          `SELECT last_run_id FROM schedules WHERE task_id = $1`,
          [CRON_TASK],
        );
        expect(fired.rows[0]!.last_run_id).toBeTruthy();

        // The task leaves every manifest: the worker row goes offline. Force
        // the schedule due again — pre-fix this created another queued run on
        // every trip, forever.
        await pool.query(`UPDATE workers SET status = 'offline'`);
        await forceDue(pool);
        // Past the skip's write-back and several clean idle ticks.
        await sleep(700);
        expect(await countScheduleRuns(pool)).toBe(1);
        expect(handle.counters.cronSkippedUnserved).toBe(1);

        // The skip advanced the schedule (it is not stuck due) and recorded
        // no run: last_run_id still names the one real fire.
        const after = await pool.query<{
          next_run_at: Date | null;
          last_run_id: string | null;
        }>(`SELECT next_run_at, last_run_id FROM schedules WHERE task_id = $1`, [CRON_TASK]);
        expect(after.rows[0]!.next_run_at).not.toBeNull();
        expect(after.rows[0]!.next_run_at!.getTime()).toBeGreaterThan(Date.now() - 10_000);
        expect(after.rows[0]!.last_run_id).toBe(fired.rows[0]!.last_run_id);
        expect(
          await pool.query(
            `SELECT 1 FROM runs WHERE task_id = $1 AND trigger_type = 'schedule'
               AND id <> $2`,
            [CRON_TASK, fired.rows[0]!.last_run_id],
          ),
        ).toEqual(expect.objectContaining({ rowCount: 0 }));

        // A serving worker comes back → the next due fire runs normally
        // again (the skip costs cadence, never the schedule).
        await pool.query(
          `UPDATE workers SET status = 'online', last_heartbeat_at = now()`,
        );
        await forceDue(pool);
        await waitForFirstRun(pool, 2);
        expect(handle.counters.cronSkippedUnserved).toBe(1);
      } finally {
        handle.stop();
      }
    });
  });

  it('treats an online row with a stale heartbeat as unserved (2-minute window)', async () => {
    await withPg('cron_unserved_heartbeat', async ({ kernel, pool }) => {
      await registerCronWorker(kernel);
      const handle = kernel.startOrchestrator({
        cron: true,
        waits: false,
        reaper: false,
        workerOffline: false,
        cronIntervalMs: 100,
        namespaces: [NS],
      });
      try {
        // status still 'online', but silent longer than WORKER_OFFLINE_MS:
        // the same window the registration guard and the offline marker use.
        await pool.query(
          `UPDATE workers SET last_heartbeat_at = now() - interval '3 minutes'`,
        );
        await forceDue(pool);
        await sleep(700);
        expect(await countScheduleRuns(pool)).toBe(0);
        expect(handle.counters.cronSkippedUnserved).toBe(1);
      } finally {
        handle.stop();
      }
    });
  });
});
