/* =============================================================================
   @better-trigger/kernel — cron next-fire write-back is judged by the DATABASE
   clock, not the daemon's (todos/p1-09), against a real Postgres.

   scanCron's due-scan carries `now() AS db_now` and computes the next fire from
   it, and the write-back clamps `next_run_at = GREATEST(next, now() + 1s)`. If
   either were missing, a daemon whose clock runs behind the DB's would write a
   next_run_at the DB still reads as due, and the same schedule would re-fire
   every tick. This suite reproduces the skew the real hazard needs: the
   process's `new Date()` is wound five minutes BEHIND the database clock
   (vitest fakes only Date; timers and PG stay real), so the daemon-side
   computation is provably wrong while the DB clock stays honest — three ticks
   must fire exactly once and land next_run_at in the DB future.
   ============================================================================= */
import { afterEach, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Kernel } from '../../src/index';
import { describePg, withPg } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const CRON_TASK = 'cron-t';
const TICKS_MS = 400;
/** How far the process clock is wound behind the database's. */
const SKEW_MS = 5 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

/** Schedule-triggered runs for a task, regardless of status. */
async function countScheduleRuns(pool: Pool, taskId: string): Promise<number> {
  const res = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM runs WHERE task_id = $1 AND trigger_type = 'schedule'`,
    [taskId],
  );
  return res.rows[0]!.count;
}

/** Poll until the schedule has fired at least once; throw on timeout. Uses
 *  performance.now() (not Date.now()) — the skew test fakes Date, which would
 *  freeze a Date.now() deadline forever. */
async function waitForFirstFire(pool: Pool, taskId: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if ((await countScheduleRuns(pool, taskId)) >= 1) return;
    if (performance.now() >= deadline) break;
    await sleep(50);
  }
  throw new Error(`schedule for task ${taskId} never fired within ${timeoutMs}ms`);
}

/** Register a worker whose manifest declares one `* * * * *` cron task. */
async function registerCronWorker(kernel: Kernel): Promise<void> {
  await kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: [{ id: CRON_TASK, codeVersion: 'v1', cron: { pattern: '* * * * *' } }],
  });
}

describePg('cron due-scan next-fire write-back', () => {
  it('fires a schedule due 5 minutes ago exactly once and moves next_run_at to the DB future', async () => {
    await withPg('cron_skew_due', async ({ kernel, pool }) => {
      await registerCronWorker(kernel);

      // Make the schedule due 5 minutes ago, as a clock-skewed registration or
      // a stuck daemon would have left it.
      await pool.query(
        `UPDATE schedules SET next_run_at = now() - interval '5 minutes' WHERE task_id = $1`,
        [CRON_TASK],
      );

      // p1-09: wind the PROCESS clock five minutes BEHIND the database. A
      // pre-fix scanCron computes the next fire from new Date() (this skewed
      // clock) and writes a next_run_at the DB still reads as due — re-firing
      // every tick. The fix computes from `now() AS db_now` and clamps with
      // GREATEST, so it stays at exactly one fire. Timers are NOT faked (the
      // orchestrator's setInterval and sleep() run on real wall time); only
      // Date is skewed.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() - SKEW_MS));

      const handle = kernel.startOrchestrator({
        cron: true,
        waits: false,
        reaper: false,
        workerOffline: false,
        cronIntervalMs: 100,
        namespaces: [NS],
      });
      try {
        await waitForFirstFire(pool, CRON_TASK, 5_000);
        // Keep ticking several more intervals: a write-back the DB still reads
        // as due would re-fire every one of them.
        await sleep(TICKS_MS);
      } finally {
        handle.stop();
        vi.useRealTimers();
      }

      expect(await countScheduleRuns(pool, CRON_TASK)).toBe(1);

      const res = await pool.query<{ next_run_at: Date }>(
        `SELECT next_run_at FROM schedules WHERE task_id = $1`,
        [CRON_TASK],
      );
      // The clamp + db_now computation guarantees the DB sees the next fire as
      // strictly in ITS future — the invariant that makes exactly-once hold
      // under clock skew. (Date.now() here is the skewed process clock, so
      // comparing against it is a weaker bound than the real one.)
      expect(res.rows[0]!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('does not fire a schedule whose next_run_at is an hour in the future', async () => {
    await withPg('cron_skew_future', async ({ kernel, pool }) => {
      await registerCronWorker(kernel);

      await pool.query(
        `UPDATE schedules SET next_run_at = now() + interval '1 hour' WHERE task_id = $1`,
        [CRON_TASK],
      );

      const handle = kernel.startOrchestrator({
        cron: true,
        waits: false,
        reaper: false,
        workerOffline: false,
        cronIntervalMs: 100,
        namespaces: [NS],
      });
      try {
        // 3-4 ticks; a spurious fire would appear within the first one, and
        // the GREATEST clamp must not have pushed anything past its due time.
        await sleep(TICKS_MS);
      } finally {
        handle.stop();
      }

      expect(await countScheduleRuns(pool, CRON_TASK)).toBe(0);
    });
  });
});
