/* =============================================================================
   @better-trigger/kernel — 04-T1 against a real Postgres: one poisoned cron
   schedule cannot stall the rest of the namespace's cron.

   Registration validates patterns/timezones, so the poison is injected the
   way it happens in production — an out-of-band edit of
   schedules.cron_pattern (dashboard / manual UPDATE). The stub suite
   (test/orchestrator-cron-poison.test.ts) pins the partition + write shapes;
   only real SQL proves the whole tick COMMITS around the poisoned row
   (pre-isolation the throw rolled it back, leaving every due schedule due
   forever) and that the quarantine (next_run_at NULL) actually sticks on the
   row.
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import { describePg, withPg } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const HEALTHY_TASK = 'healthy-cron';
const POISON_TASK = 'poison-cron';
/** Never naturally due (once a year): every fire in these tests is a
 *  forceDue(), so there is no minute-boundary race between the phases. */
const CRON_PATTERN = '0 0 1 1 *';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function countScheduleRuns(pool: Pool, taskId: string): Promise<number> {
  const res = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM runs WHERE task_id = $1 AND trigger_type = 'schedule'`,
    [taskId],
  );
  return res.rows[0]!.count;
}

/** Make a schedule overdue so the next tick finds it due. */
async function forceDue(pool: Pool, taskId: string): Promise<void> {
  await pool.query(
    `UPDATE schedules SET next_run_at = now() - interval '5 minutes' WHERE task_id = $1`,
    [taskId],
  );
}

async function waitForRuns(
  pool: Pool,
  taskId: string,
  atLeast: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await countScheduleRuns(pool, taskId)) < atLeast) {
    if (Date.now() > deadline) {
      throw new Error(`schedule ${taskId} never produced run #${atLeast}`);
    }
    await sleep(50);
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
}

describePg('cron poison isolation (04-T1)', () => {
  it('a poisoned schedule is quarantined (next_run_at NULL) while the healthy one keeps firing', async () => {
    await withPg('cron_poison', async ({ kernel, pool }) => {
      await kernel.registerWorker({
        codeVersion: 'v1',
        runtime: 'test',
        concurrency: 1,
        namespaces: [NS],
        tasks: [
          { id: HEALTHY_TASK, codeVersion: 'v1', cron: { pattern: CRON_PATTERN } },
          { id: POISON_TASK, codeVersion: 'v1', cron: { pattern: CRON_PATTERN } },
        ],
      });

      const handle = kernel.startOrchestrator({
        cron: true,
        waits: false,
        reaper: false,
        workerOffline: false,
        cronIntervalMs: 100,
        namespaces: [NS],
      });
      try {
        // Baseline: both schedules fire while both patterns parse.
        await forceDue(pool, HEALTHY_TASK);
        await forceDue(pool, POISON_TASK);
        await waitForRuns(pool, HEALTHY_TASK, 1);
        await waitForRuns(pool, POISON_TASK, 1);
        expect(handle.counters.cronPoisoned).toBe(0);
        expect(handle.counters.loopErrors.cron).toBe(0);

        // Poison one row the way production does: an out-of-band edit of the
        // stored pattern (registration would have refused it).
        await pool.query(`UPDATE schedules SET cron_pattern = 'not a cron' WHERE task_id = $1`, [
          POISON_TASK,
        ]);
        await forceDue(pool, HEALTHY_TASK);
        await forceDue(pool, POISON_TASK);

        // The healthy schedule fires again — the poison in the SAME batch did
        // not stall it (pre-isolation the throw rolled the tick back and
        // neither advanced). The poisoned one still fires its legitimately-due
        // run, and is quarantined right after.
        await waitForRuns(pool, HEALTHY_TASK, 2);
        await waitForRuns(pool, POISON_TASK, 2);
        await waitFor(() => handle.counters.cronPoisoned > 0);
        expect(handle.counters.loopErrors.cron).toBe(0);
        expect(handle.counters.cronSkippedUnserved).toBe(0);

        // The quarantine stuck on the real row: next_run_at NULL (silent
        // until the pattern is fixed and the schedule re-enabled /
        // re-registered), and the fire is recorded.
        const poisonedRow = await pool.query<{
          next_run_at: Date | null;
          last_run_id: string | null;
        }>(`SELECT next_run_at, last_run_id FROM schedules WHERE task_id = $1`, [POISON_TASK]);
        expect(poisonedRow.rows[0]!.next_run_at).toBeNull();
        expect(poisonedRow.rows[0]!.last_run_id).toBeTruthy();

        // And the poison stays silent afterwards: no further fires even after
        // several idle ticks (a NULL next_run_at is never due).
        await sleep(500);
        expect(await countScheduleRuns(pool, POISON_TASK)).toBe(2);

        // The healthy schedule's cadence is untouched: one more forced due →
        // one more fire.
        await forceDue(pool, HEALTHY_TASK);
        await waitForRuns(pool, HEALTHY_TASK, 3);
        expect(handle.counters.cronPoisoned).toBe(1);
        expect(handle.counters.loopErrors.cron).toBe(0);
      } finally {
        handle.stop();
      }
    });
  });
});
