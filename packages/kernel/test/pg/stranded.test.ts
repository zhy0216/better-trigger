/* =============================================================================
   @better-trigger/kernel — 04-T4 against a real Postgres: the stranded-run
   scan's "served" reading shares ONE heartbeat window with every other
   surface.

   Pre-fix, scanStrandedRuns only required status='online' while the cron
   served-check and the registration guard also demanded a heartbeat inside
   the offline-marker window — a worker that stopped heartbeating got opposite
   answers from the two observation surfaces for up to a window (the offline
   marker flips the status only on its own 30s tick). The scan now applies
   the same WORKER_OFFLINE_MS window, bound as a parameter like its siblings.
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Kernel } from '../../src/index';
import { scanStrandedRuns } from '../../src/queue';
import { describePg, withPg } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const TASK_ID = 'pin-task';
const VERSION = 'v-gone';

async function seedPinnedRun(kernel: Kernel, pool: Pool): Promise<string> {
  await kernel.registerWorker({
    codeVersion: VERSION,
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: [{ id: TASK_ID, codeVersion: VERSION }],
  });
  const { runId } = await kernel.trigger({ taskId: TASK_ID, payload: {}, namespace: NS });
  // The run is stamped with the task's registered version — the column the
  // stranded scan filters on.
  const row = await pool.query<{ code_version: string }>(
    `SELECT code_version FROM runs WHERE id = $1`,
    [runId],
  );
  expect(row.rows[0]!.code_version).toBe(VERSION);
  return runId;
}

async function scan(pool: Pool) {
  return scanStrandedRuns(pool, [NS]);
}

describePg('stranded-run scan heartbeat window (04-T4)', () => {
  it('a fresh online worker serves the run; a stale-heartbeat one no longer does', async () => {
    await withPg('stranded_window', async ({ kernel, pool }) => {
      const runId = await seedPinnedRun(kernel, pool);

      // Online, heartbeating (the registration just wrote a fresh one):
      // served → nothing stranded.
      expect((await scan(pool)).groups).toEqual([]);

      // The worker stops heartbeating but its row is still status='online'
      // (the offline marker has not run yet). Past the window the stranded
      // scan must agree with the cron served-check and the registration
      // guard: the run IS stranded. Pre-fix this reported empty.
      await pool.query(
        `UPDATE workers SET last_heartbeat_at = now() - interval '3 minutes'`,
      );
      const stale = await scan(pool);
      expect(stale.groups).toEqual([{ taskId: TASK_ID, codeVersion: VERSION, count: 1 }]);
      expect(stale.truncated).toBe(false);

      // Inside the window again (heartbeat lands): served once more.
      await pool.query(`UPDATE workers SET last_heartbeat_at = now()`);
      expect((await scan(pool)).groups).toEqual([]);

      // And a row flipped offline by the marker is still stranded, of course.
      await pool.query(`UPDATE workers SET status = 'offline'`);
      expect((await scan(pool)).groups).toEqual([
        { taskId: TASK_ID, codeVersion: VERSION, count: 1 },
      ]);

      // Cleanup sanity: the run was never claimed by any of this.
      const queue = await pool.query<{ locked_by: string | null }>(
        `SELECT locked_by FROM queue WHERE run_id = $1`,
        [runId],
      );
      expect(queue.rows[0]!.locked_by).toBeNull();
    });
  });

  it('a legacy bare-id manifest still serves (normalization shared with the guard)', async () => {
    await withPg('stranded_legacy', async ({ kernel, pool }) => {
      await seedPinnedRun(kernel, pool);

      // Rewrite the manifest to the OLD shape: a bare id string, no per-task
      // codeVersion. It normalizes to the worker-level code_version — the
      // version that build stamped — which is exactly the run's version.
      await pool.query(`UPDATE workers SET tasks = $1::jsonb`, [
        JSON.stringify([TASK_ID]),
      ]);
      expect((await scan(pool)).groups).toEqual([]);

      // A legacy row of a DIFFERENT build (code_version mismatch) does not
      // serve the run.
      await pool.query(`UPDATE workers SET code_version = 'v-other'`);
      expect((await scan(pool)).groups).toEqual([
        { taskId: TASK_ID, codeVersion: VERSION, count: 1 },
      ]);
    });
  });
});
