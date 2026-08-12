/* =============================================================================
   @better-trigger/kernel — orphan run-wait recovery survives a SUSTAINED
   due-timer backlog (todos/p1-05) against a real Postgres.

   scanWaits phase 1 now runs TWO independent scans: a due-timer scan
   (kind 'duration'/'until', resume_at <= now(), LIMIT 50) and an orphan scan
   (kind 'run' AND child_run_id IS NULL, LIMIT 10). Before the split there was
   one query `ORDER BY resume_at ASC LIMIT 50`; Postgres sorts ASC with
   NULLS LAST, so the orphan run-wait (resume_at IS NULL) always landed after
   every due timer wait.

   This suite seeds a SUSTAINED backlog: 600 due timer waits + 1 orphan
   run-wait (child deleted out from under it, waits.child_run_id ON DELETE
   SET NULL → NULL). 600 is not arbitrary — it is the smallest count whose
   drain time exceeds the pre-fix starvation window:

     * Post-fix: the orphan is row 1 of its own LIMIT-10 scan, so it terminal-
       fails on the FIRST tick. That tick has drained only its first LIMIT-50
       timer window, so at the moment the parent is observed 'failed' at least
       ~500 of the 600 timer waits are still 'pending' — and the `>= 500`
       pending assertion passes. (500 is the floor, not 550: the poll's
       snapshot can land up to one tick later, whose 50-resume window bottoms
       the count out at exactly 500; `>=` absorbs that.)
     * Pre-fix: one query ORDER BY resume_at ASC LIMIT 50 (NULLS LAST) sorts
       the orphan dead last. The 600 timers drain in exactly 12 full windows
       (tick 1..12 × 50), and only on tick 13 does the orphan reach the
       LIMIT-50 window — by which point ~0 timers are 'pending'. The `>= 500`
       pending assertion fails. Reverting the fix turns this test red.

   The decisive assertion is the pending-timer count read in the SAME snapshot
   that observes the orphan parent 'failed'. The snapshot is taken at most one
   poll-interval after the orphan terminal-fails at the tail of its tick, and
   a 50ms timerInterval caps how far the backlog can have drained in between.

   Worker registration: deliberately skipped. scanWaits' phase 2 touches only
   runs/waits/queue/run_steps — tryLockRunRow, terminalFail and upsertStep have
   no dependency on the workers or tasks tables (runs.task_id is a bare text
   column with no FK), and the phase-1 scans read waits alone. registerWorker
   would add nothing but noise, so the rows are seeded directly.
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import { describePg, withPg } from './helpers';

const NS = { projectId: 'default', env: 'prod' };
const TASK_ID = 'p1-05-task';
const TIMER_RUNS = 600;
const ORPHAN_RUN = 'run-orphan';

/** Seed 600 due timer waits (runs 'waiting' + kind 'duration' waits already
 *  past resume_at, no queue rows — a suspended run has none) and 1 orphan
 *  run-wait (runs 'waiting' + kind 'run' wait with child_run_id NULL and
 *  resume_at NULL, the C5 shape after the child run was deleted). */
async function seedBacklog(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type)
       SELECT 'run-timer-' || g, $1, $2, $3, 'waiting', 'api'
         FROM generate_series(0, $4::int) g`,
    [NS.projectId, NS.env, TASK_ID, TIMER_RUNS - 1],
  );
  await pool.query(
    `INSERT INTO waits (run_id, project_id, env, step_seq, kind, resume_at, status)
       SELECT 'run-timer-' || g, $1, $2, 0, 'duration', now() - interval '1 hour', 'pending'
         FROM generate_series(0, $3::int) g`,
    [NS.projectId, NS.env, TIMER_RUNS - 1],
  );

  await pool.query(
    `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type)
     VALUES ($1, $2, $3, $4, 'waiting', 'api')`,
    [ORPHAN_RUN, NS.projectId, NS.env, TASK_ID],
  );
  await pool.query(
    `INSERT INTO waits (run_id, project_id, env, step_seq, kind, child_run_id, resume_at, status)
     VALUES ($1, $2, $3, 0, 'run', NULL, NULL, 'pending')`,
    [ORPHAN_RUN, NS.projectId, NS.env],
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Snapshot {
  orphanStatus: string | null;
  orphanError: unknown;
  orphanWaitStatus: string | null;
  pendingTimers: number;
  queuedTimers: number;
}

/** One MVCC-snapshot read of everything the test needs, so the orphan-parent
 *  status and the timer-backlog depth are measured at the SAME instant. */
async function readSnapshot(pool: Pool): Promise<Snapshot> {
  const res = await pool.query<{
    orphan_status: string | null;
    orphan_error: unknown;
    orphan_wait_status: string | null;
    pending_timers: number;
    queued_timers: number;
  }>(
    `SELECT
       (SELECT status FROM runs WHERE id = $1) AS orphan_status,
       (SELECT error FROM runs WHERE id = $1) AS orphan_error,
       (SELECT status FROM waits WHERE run_id = $1) AS orphan_wait_status,
       (SELECT count(*)::int FROM waits
         WHERE status = 'pending' AND kind IN ('duration','until')) AS pending_timers,
       (SELECT count(*)::int FROM runs
         WHERE id LIKE 'run-timer-%' AND status = 'queued') AS queued_timers`,
    [ORPHAN_RUN],
  );
  const r = res.rows[0]!;
  return {
    orphanStatus: r.orphan_status,
    orphanError: r.orphan_error,
    orphanWaitStatus: r.orphan_wait_status,
    pendingTimers: r.pending_timers,
    queuedTimers: r.queued_timers,
  };
}

/** Poll every 25ms for the orphan parent to terminal-fail; return the snapshot
 *  taken the moment it is observed, so pendingTimers reflects the backlog WHILE
 *  the recovery happened. On timeout, throw with the last snapshot. */
async function waitForOrphanFailure(pool: Pool, timeoutMs: number): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: Snapshot | undefined;
  for (;;) {
    last = await readSnapshot(pool);
    if (last.orphanStatus === 'failed') return last;
    if (Date.now() >= deadline) break;
    await sleep(25);
  }
  throw new Error(
    `orphan parent never terminal-failed (timeout ${timeoutMs}ms); ` +
      `last snapshot=${JSON.stringify(last)}`,
  );
}

describePg('orphan run-wait recovery under a due-timer backlog', () => {
  it('fails the orphan parent (ChildLostError) while 500+ of the 600 timers are still pending', async () => {
    await withPg('orphan', async ({ kernel, pool }) => {
      await seedBacklog(pool);

      // Only the wait-due loop runs: everything else is off. There is no `gc`
      // flag in OrchestratorOptions — retention GC only exists when
      // `retentionMs` is set (it is not), so nothing else can touch the rows.
      const handle = kernel.startOrchestrator({
        waits: true,
        timerIntervalMs: 50,
        cron: false,
        reaper: false,
        workerOffline: false,
        stranded: false,
        namespaces: [NS],
      });
      try {
        // THE BITE: the orphan fails on its own LIMIT-10 scan's FIRST tick,
        // while the 600-timer backlog (drained 50/tick) is still ~550 deep.
        // pendingTimers is read in the same snapshot as the 'failed' status,
        // so it measures the backlog the instant recovery happened. Pre-fix,
        // the orphan only reached the LIMIT-50 window after all 600 timers
        // drained (tick 13) — this snapshot would then read ~0 and fail.
        const s = await waitForOrphanFailure(pool, 10_000);
        expect(s.pendingTimers).toBeGreaterThanOrEqual(500);

        // a. Orphan path: parent terminal-failed with ChildLostError, its
        //    pending wait canceled.
        expect(s.orphanError).toMatchObject({ name: 'ChildLostError' });
        expect(s.orphanWaitStatus).toBe('canceled');

        // b. Timer path still works: the resume ran for at least the first
        //    LIMIT-50 window before the orphan failed, so runs went 'queued'.
        expect(s.queuedTimers).toBeGreaterThanOrEqual(1);
      } finally {
        handle.stop();
      }
    });
  });
});
