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

async function registerCronWorker(kernel: Kernel, namespace = NS): Promise<string> {
  const { workerId } = await kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [namespace],
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

describePg('cron namespace pairs containing slashes', () => {
  const A = { projectId: 'a/b', env: 'c' };
  const B = { projectId: 'a', env: 'b/c' };

  it.each([false, true])(
    'isolates fires, skips and worker recovery (reverse namespaces: %s)',
    async (reverse) => {
      await withPg('cron_namespace_pair', async ({ kernel, pool }) => {
        const namespaces = reverse ? [B, A] : [A, B];
        await registerCronWorker(kernel, A);
        const workerB = await registerCronWorker(kernel, B);
        await pool.query(`UPDATE workers SET status = 'offline' WHERE id = $1`, [workerB]);

        const snapshot = async () => {
          const result = await pool.query<{
            project_id: string;
            env: string;
            last_run_at: Date | null;
            last_run_id: string | null;
            advanced: boolean;
            runs: number;
            queued: number;
          }>(
            `SELECT s.project_id, s.env, s.last_run_at, s.last_run_id,
                    s.next_run_at > now() AS advanced,
                    (SELECT count(*)::int FROM runs r
                      WHERE r.task_id = s.task_id AND r.trigger_type = 'schedule'
                        AND r.project_id = s.project_id AND r.env = s.env) AS runs,
                    (SELECT count(*)::int FROM queue q
                      WHERE q.project_id = s.project_id AND q.env = s.env) AS queued
               FROM schedules s WHERE s.task_id = $1`,
            [CRON_TASK],
          );
          return result.rows;
        };
        const expectCounts = async (counts: number[]) => {
          const rows = await snapshot();
          expect(rows).toHaveLength(2);
          return [A, B].map((ns, i) => {
            const row = rows.find((r) => r.project_id === ns.projectId && r.env === ns.env)!;
            expect(row).toMatchObject({ advanced: true, runs: counts[i], queued: counts[i] });
            if (counts[i] === 0) {
              expect(row.last_run_id).toBeNull();
              expect(row.last_run_at).toBeNull();
            } else {
              expect(row.last_run_id).toBeTruthy();
              expect(row.last_run_at).toBeInstanceOf(Date);
            }
            return row;
          });
        };

        const handle = kernel.startOrchestrator({
          cron: true,
          waits: false,
          reaper: false,
          workerOffline: false,
          cronIntervalMs: 50,
          namespaces,
        });
        const waitForIdleTick = async () => {
          const previous = handle.counters.loopLastSuccess.cron;
          await expect.poll(() => handle.counters.loopLastSuccess.cron, { timeout: 5_000 })
            .toBeGreaterThan(previous);
          expect(handle.counters.loopErrors.cron).toBe(0);
        };
        const fireDue = async () => {
          await forceDue(pool);
          // Check against the DB clock and wait for both write-backs to
          // COMMIT, including the skipped row that never creates a run.
          await expect.poll(async () => (await snapshot()).every((r) => r.advanced), { timeout: 5_000 })
            .toBe(true);
          await waitForIdleTick();
        };
        try {
          // Registered schedules are in the future and both queues are empty.
          await waitForIdleTick();
          await expectCounts([0, 0]);
          expect(handle.counters.cronSkippedUnserved).toBe(0);

          // Only A is online: B must consume its fire without creating a run.
          await fireDue();
          const first = await expectCounts([1, 0]);
          expect(handle.counters.cronSkippedUnserved).toBe(1);

          // Switch service to B without changing either task id. A's prior
          // last_run_* must survive its skipped fire unchanged.
          await pool.query(
            `UPDATE workers
                SET status = CASE WHEN id = $1 THEN 'online' ELSE 'offline' END,
                    last_heartbeat_at = now()`,
            [workerB],
          );
          await fireDue();
          const switched = await expectCounts([1, 1]);
          expect(switched[0]!.last_run_id).toBe(first[0]!.last_run_id);
          expect(switched[0]!.last_run_at).toEqual(first[0]!.last_run_at);
          expect(handle.counters.cronSkippedUnserved).toBe(2);

          // A returns: both pairs can fire independently on the next due scan.
          await pool.query(`UPDATE workers SET status = 'online', last_heartbeat_at = now()`);
          await fireDue();
          const recovered = await expectCounts([2, 2]);
          for (let i = 0; i < recovered.length; i++) {
            expect(recovered[i]!.last_run_id).not.toBe(switched[i]!.last_run_id);
          }
          expect(handle.counters.cronSkippedUnserved).toBe(2);

          // Another empty due scan neither duplicates runs nor consumes fires.
          await waitForIdleTick();
          expect(await expectCounts([2, 2])).toEqual(recovered);
          expect(handle.counters.cronSkippedUnserved).toBe(2);
          expect(handle.counters.cronPoisoned).toBe(0);
        } finally {
          handle.stop();
        }
      });
    },
  );
});
