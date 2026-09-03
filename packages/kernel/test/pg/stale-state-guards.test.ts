/* =============================================================================
   @better-trigger/kernel — stale-state transition guards (todos/p2-39) against
   a real Postgres.

   Terminal states ('completed'/'failed'/'canceled') are one-way: no claim,
   wait-resume or reap path may ever write a terminal run back to
   'queued'/'running'. The public API already serializes on the canonical
   lock order (queue → runs → waits), so the dangerous shapes can only be
   PRODUCED by seeding stale rows directly — and the fault-injection pass
   (the experiment this suite replaces) recorded exactly that:

     - a terminal run + residual unlocked queue row WAS resurrected by claim
       (completed → running, fencing token bumped, lease taken);
     - a completed run + pending due timer wait WAS resurrected by the
       wait-due scanner (completed → queued, step row written, re-enqueued);
     - a terminal run + expired-lease queue row WAS resurrected by the reaper
       (completed → queued, recoveries spent);
     - a 'waiting' run + stale unlocked queue row WAS claimed back to running;
     - the same shapes raced via the public API (cancel × timer resume, 30
       rounds, clean state) produced ZERO violations — the holes are
       fault-injection-only, which is what keeps this a P2 hardening rather
       than a P1.

   This suite pins the guards that closed those holes: claim candidates must
   be 'queued' and the flip is checked before any lease/ledger write; timer
   resume flips only 'waiting' runs and retires stale waits with a log; the
   reaper leaves non-'running' runs alone and clears their stale queue rows;
   and a 100-round cancel/complete/reaper/claim/timer interleave never
   produces a terminal regression, a queue residue or an illegal fencing
   advance.
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Namespace } from '@better-trigger/core';
import { describePg, withPg } from './helpers';
import { createKernel, type Kernel, type KernelLogger } from '../../src/index';
import {
  seedGhostQueueRow,
  seedQueueRow,
  seedRun,
  seedWait,
} from './stale-state-helpers';

const NS = { projectId: 'default', env: 'prod' };
const TASK_A = 'stale-a';
const TASK_B = 'stale-b';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['completed', 'failed', 'canceled'];

/**
 * Claim exactly one run with bounded retry. Since 05-T1 the trigger stamps
 * available_at from the DATABASE clock (the same now() the claim predicate
 * compares against), so there is no host↔DB skew to absorb; the short retry
 * window is kept as a plain scheduling-timing defense so a healthy-but-not-
 * yet-visible run never makes `claimRuns(...)[0]!` throw a TypeError, without
 * weakening the race being tested (only the settle timing changes).
 */
async function claimOne(
  kernel: Kernel,
  args: {
    workerId: string;
    namespaces: Namespace[];
    taskIds: string[];
    leaseMs: number;
    timeoutMs?: number;
  },
): Promise<{ id: string; fencingToken: number }> {
  const timeout = args.timeoutMs ?? 200;
  const deadline = Date.now() + timeout;
  for (;;) {
    const claimed = await kernel.claimRuns({
      workerId: args.workerId,
      namespaces: args.namespaces,
      taskIds: args.taskIds,
      limit: 1,
      leaseMs: args.leaseMs,
    });
    if (claimed[0]) return { id: claimed[0].id, fencingToken: claimed[0].fencingToken };
    if (Date.now() > deadline) {
      throw new Error(
        `claimOne: no run claimed for tasks [${args.taskIds.join(', ')}] within ${timeout}ms`,
      );
    }
    await sleep(10);
  }
}

/**
 * Poll a run's status until it leaves the given transient set (bounded).
 * Returns the settled status, or throws naming the holdout — used where an
 * orchestrator loop (timer scanner, reaper) races the round's ops and may
 * simply not have reached the run yet when the round's sleep ends: asserting
 * a half-settled state is the flake, not the race.
 */
async function settleStatus(
  pool: Pool,
  runId: string,
  transient: readonly string[],
  timeoutMs = 3_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = (await runStatus(pool, runId)) ?? 'missing';
  while (transient.includes(status) && Date.now() < deadline) {
    await sleep(25);
    status = (await runStatus(pool, runId)) ?? 'missing';
  }
  if (transient.includes(status)) {
    throw new Error(
      `run ${runId} still '${status}' after ${timeoutMs}ms (wanted it to leave ` +
        `${transient.join('/')}) — an orchestrator loop never settled it`,
    );
  }
  return status;
}

/** A logger that keeps every warn/error line for assertions. */
function capturingLogger(lines: string[]): KernelLogger {
  return {
    warn: (...args: unknown[]) => lines.push(String(args[0])),
    error: (...args: unknown[]) => lines.push(String(args[0])),
  };
}

async function runStatus(pool: Pool, id: string): Promise<string | null> {
  const res = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [id]);
  return res.rows[0]?.status ?? null;
}

async function queueRowCount(pool: Pool, id: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM queue WHERE run_id = $1`,
    [id],
  );
  return res.rows[0]!.n;
}

async function pendingWaitCount(pool: Pool, id: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM waits WHERE run_id = $1 AND status = 'pending'`,
    [id],
  );
  return res.rows[0]!.n;
}

async function stepCount(pool: Pool, id: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM run_steps WHERE run_id = $1`,
    [id],
  );
  return res.rows[0]!.n;
}

async function tokenOf(pool: Pool, id: string): Promise<number> {
  const res = await pool.query<{ t: string }>(
    `SELECT fencing_token::text AS t FROM runs WHERE id = $1`,
    [id],
  );
  return Number(res.rows[0]?.t ?? '0');
}

/**
 * The queue↔runs↔waits consistency picture, in one snapshot:
 *   - no queue row for a run that is 'waiting' or terminal;
 *   - no pending wait on a run that is not 'waiting';
 *   - a locked queue row only ever sits under a 'running' run;
 *   - an unlocked queue row only ever sits under a 'queued' run.
 */
async function assertStaleInvariants(pool: Pool): Promise<void> {
  const badQueue = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM queue q JOIN runs r ON r.id = q.run_id
      WHERE r.status IN ('waiting','completed','failed','canceled')`,
  );
  expect(badQueue.rows[0]!.n).toBe(0);
  const badPending = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM waits w JOIN runs r ON r.id = w.run_id
      WHERE w.status = 'pending' AND r.status <> 'waiting'`,
  );
  expect(badPending.rows[0]!.n).toBe(0);
  const badLock = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM queue q JOIN runs r ON r.id = q.run_id
      WHERE q.locked_by IS NOT NULL AND r.status <> 'running'`,
  );
  expect(badLock.rows[0]!.n).toBe(0);
  const badUnlock = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM queue q JOIN runs r ON r.id = q.run_id
      WHERE q.locked_by IS NULL AND r.status <> 'queued'`,
  );
  expect(badUnlock.rows[0]!.n).toBe(0);
}

describePg('stale-state transition guards (p2-39)', () => {
  it('claim never claims a non-queued run: terminal/waiting rows stay terminal/waiting, queue rows stay unlocked, fencing untouched', async () => {
    await withPg('stale_claim_refuses', async ({ kernel, pool }) => {
      for (const status of ['completed', 'failed', 'canceled', 'waiting', 'running']) {
        await seedRun(pool, { id: `run-${status}`, taskId: TASK_A, status }, NS);
        await seedQueueRow(pool, { runId: `run-${status}` }, NS);
      }

      const claimed = await kernel.claimRuns({
        workerId: 'w',
        namespaces: [NS],
        taskIds: [TASK_A],
        limit: 10,
        leaseMs: 60_000,
      });
      expect(claimed).toEqual([]);

      // The candidate scan filters on `r.status = 'queued'`, so none of these
      // seeded rows is ever a candidate: claim never reaches the 0-row flip
      // branch for them, and their queue rows are NOT deleted here (the
      // 0-row cleanup only fires for a run that LEFT 'queued' mid-claim — see
      // the dedicated race test below). Every row stays exactly as seeded.
      for (const status of ['completed', 'failed', 'canceled', 'waiting', 'running']) {
        expect(await runStatus(pool, `run-${status}`)).toBe(status);
        expect(await tokenOf(pool, `run-${status}`)).toBe(0);
        const q = await pool.query<{ locked_by: string | null }>(
          `SELECT locked_by FROM queue WHERE run_id = $1`,
          [`run-${status}`],
        );
        expect(q.rows).toHaveLength(1);
        expect(q.rows[0]!.locked_by).toBeNull();
      }
    });
  });

  it('claim 0-row flip cleans the stale queue row when the run left queued mid-claim: terminal → deleted, running → kept (source: claim)', async () => {
    await withPg('stale_claim_race_cleanup', async ({ kernel, pool }) => {
      // The 0-row flip branch only fires when a run leaves 'queued' BETWEEN
      // the candidate scan and the flip — unreachable through the public API,
      // so fault-inject it: a raw-SQL tx holds the runs row lock while moving
      // the run, the claim's flip UPDATE parks on it, and committing the raw
      // tx wakes the flip to 0 rows. Terminal (or waiting) ⇒ the stale queue
      // row is deleted; 'running' ⇒ the row belongs to a live-claim race and
      // is kept.
      await seedRun(pool, { id: 'run-race-terminal', taskId: TASK_A, status: 'queued' }, NS);
      await seedQueueRow(pool, { runId: 'run-race-terminal' }, NS);
      await seedRun(pool, { id: 'run-race-running', taskId: TASK_A, status: 'queued' }, NS);
      await seedQueueRow(pool, { runId: 'run-race-running' }, NS);

      const lines: string[] = [];
      const raw = await pool.connect();
      try {
        await raw.query('BEGIN');
        await raw.query(
          `UPDATE runs SET status = 'completed', finished_at = now() WHERE id = 'run-race-terminal'`,
        );
        await raw.query(
          `UPDATE runs SET status = 'running' WHERE id = 'run-race-running'`,
        );

        const pending = kernel.claimRuns({
          workerId: 'w',
          namespaces: [NS],
          taskIds: [TASK_A],
          limit: 5,
          leaseMs: 60_000,
          logger: capturingLogger(lines),
        });
        // Wait until the claim is genuinely parked on the uncommitted flip
        // before releasing it — committing too early would let the claim see
        // the new statuses at scan time and never exercise the 0-row branch.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const blocked = await pool.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE query LIKE '%SET status = ''running''%'
                AND state = 'active' AND wait_event IS NOT NULL`,
          );
          if (blocked.rows[0].n > 0) break;
          if (Date.now() > deadline) throw new Error('claim never blocked on the raw flips');
          await sleep(20);
        }
        await raw.query('COMMIT');

        expect(await pending).toEqual([]);
      } finally {
        // The raw tx may still be open on a failure path (the blocked-wait
        // deadline); node-pg does not roll back released clients, so close it
        // explicitly before the connection goes back to the pool.
        await raw.query('ROLLBACK').catch(() => {});
        raw.release();
      }

      // Terminal: the stale queue row is deleted (source: claim), the run
      // untouched, no fencing advance. Running: the queue row is someone's
      // live-claim race — kept, and the skip is still said out loud.
      expect(await runStatus(pool, 'run-race-terminal')).toBe('completed');
      expect(await queueRowCount(pool, 'run-race-terminal')).toBe(0);
      expect(await tokenOf(pool, 'run-race-terminal')).toBe(0);
      expect(await runStatus(pool, 'run-race-running')).toBe('running');
      expect(await queueRowCount(pool, 'run-race-running')).toBe(1);
      expect(await tokenOf(pool, 'run-race-running')).toBe(0);
      expect(
        lines.some(
          (m) =>
            m.includes('[queue:claim]') &&
            m.includes('stale queue row deleted') &&
            m.includes('source: claim'),
        ),
      ).toBe(true);
      expect(
        lines.some(
          (m) => m.includes('[queue:claim]') && m.includes("runs.status 'running'"),
        ),
      ).toBe(true);
    });
  });

  it('timer resume never resurrects a non-waiting run: stale wait canceled, no step row, nothing enqueued, and the skip is logged', async () => {
    await withPg('stale_timer_refuses', async ({ pool }) => {
      // SQL-constructed desync: the wait is due, the run is anything but
      // 'waiting'. Seeded BEFORE the kernel exists so nothing can move them.
      // Terminal runs get a leftover queue row too — the worst desync — which
      // the stale cleanup must delete while the run stays terminal.
      for (const status of ['completed', 'failed', 'canceled', 'queued', 'running']) {
        await seedRun(pool, { id: `run-${status}`, taskId: TASK_A, status }, NS);
        await seedWait(pool, {
          runId: `run-${status}`,
          kind: 'duration',
          resumeAt: new Date(Date.now() - 3_600_000),
        }, NS);
        if (TERMINAL.includes(status)) {
          await seedQueueRow(pool, { runId: `run-${status}` }, NS);
        }
      }

      const lines: string[] = [];
      const kernel = createKernel({ pool, logger: capturingLogger(lines) });
      const handle = kernel.startOrchestrator({
        namespaces: [NS],
        timerIntervalMs: 30,
        cron: false,
        reaper: false,
        workerOffline: false,
        stranded: false,
      });
      try {
        // Wait until every seeded wait left 'pending' (the scanner retires each
        // one as stale) — or until the timeout names the holdout.
        const deadline = Date.now() + 5_000;
        let left = 5;
        while (left > 0 && Date.now() < deadline) {
          await sleep(50);
          const res = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM waits WHERE status = 'pending'`,
          );
          left = res.rows[0]!.n;
        }
        expect(left).toBe(0);
      } finally {
        handle.stop();
      }

      for (const status of ['completed', 'failed', 'canceled', 'queued', 'running']) {
        // Run untouched, wait retired as 'canceled' (never 'completed'), and
        // the resume wrote nothing: no step row, no queue row.
        expect(await runStatus(pool, `run-${status}`)).toBe(status);
        const w = await pool.query<{ s: string }>(
          `SELECT status AS s FROM waits WHERE run_id = $1`,
          [`run-${status}`],
        );
        expect(w.rows[0]!.s).toBe('canceled');
        expect(await stepCount(pool, `run-${status}`)).toBe(0);
        expect(await queueRowCount(pool, `run-${status}`)).toBe(0);
      }
      // The skip is said out loud: run id, its actual status and the stale
      // wait id, so the desync can be traced to its source. Terminal runs'
      // leftover queue rows are deleted in the same pass.
      expect(lines.some((m) => m.includes('[orchestrator:waits]') && m.includes('stale timer wait'))).toBe(true);
      expect(lines.some((m) => m.includes("runs.status 'completed', not 'waiting'"))).toBe(true);
      expect(lines.some((m) => m.includes('stale queue row deleted'))).toBe(true);
    });
  });

  it('a healthy timer wait still resumes exactly once (guard does not break the normal path)', async () => {
    await withPg('stale_timer_healthy', async ({ kernel, pool }) => {
      const { workerId } = await kernel.registerWorker({
        codeVersion: 'v1', runtime: 'test', concurrency: 4, namespaces: [NS],
        tasks: [{ id: TASK_A, codeVersion: 'v1' }],
      });
      const handle = kernel.startOrchestrator({
        namespaces: [NS],
        timerIntervalMs: 30,
        cron: false,
        reaper: false,
        workerOffline: false,
        stranded: false,
      });
      try {
        const { runId } = await kernel.trigger({ taskId: TASK_A, payload: {}, namespace: NS });
        const claim = await claimOne(kernel, {
          workerId, namespaces: [NS], taskIds: [TASK_A], leaseMs: 60_000,
        });
        expect(claim.id).toBe(runId);
        const res = await kernel.suspendRun({
          runId, namespace: NS, seq: 0, kind: 'duration',
          resumeAt: new Date(Date.now() + 40).toISOString(),
          fingerprint: 'fp-healthy', workerId, fencingToken: claim.fencingToken,
        });
        expect(res.resumed).toBe(false);

        // The run comes back 'queued' with its wait completed and a step row.
        const deadline = Date.now() + 5_000;
        while ((await runStatus(pool, runId)) === 'waiting' && Date.now() < deadline) {
          await sleep(30);
        }
        expect(await runStatus(pool, runId)).toBe('queued');
        expect(await pendingWaitCount(pool, runId)).toBe(0);
        expect(await stepCount(pool, runId)).toBe(1);
        expect(await queueRowCount(pool, runId)).toBe(1);
      } finally {
        handle.stop();
      }
    });
  });

  it('stale queue rows (ghost run, cross-namespace run) are never claimed and never advance a fencing token', async () => {
    await withPg('stale_queue_rows', async ({ kernel, pool }) => {
      // Cross-namespace: the run lives in 'other', the queue row in NS — the
      // FK only binds run_id, so a cross-namespace row is insertable.
      await seedRun(
        pool, { id: 'run-cross', taskId: TASK_A, status: 'queued' },
        { projectId: 'other', env: 'prod' },
      );
      await seedQueueRow(pool, { runId: 'run-cross' }, NS);
      // Ghost: a queue row whose run does not exist at all.
      await seedGhostQueueRow(pool, 'run-ghost', NS);

      const claimed = await kernel.claimRuns({
        workerId: 'w', namespaces: [NS], taskIds: [TASK_A], limit: 5, leaseMs: 60_000,
      });
      expect(claimed).toEqual([]);

      const cross = await pool.query<{ status: string; t: string }>(
        `SELECT status, fencing_token::text AS t FROM runs WHERE id = 'run-cross'`,
      );
      expect(cross.rows[0]).toMatchObject({ status: 'queued', t: '0' });
      const crossQ = await pool.query<{ locked_by: string | null }>(
        `SELECT locked_by FROM queue WHERE run_id = 'run-cross'`,
      );
      expect(crossQ.rows[0]!.locked_by).toBeNull();
      const ghostQ = await pool.query<{ n: number; locked_by: string | null }>(
        `SELECT count(*)::int AS n, max(locked_by) AS locked_by FROM queue WHERE run_id = 'run-ghost'`,
      );
      expect(ghostQ.rows[0]!.n).toBe(1);
      expect(ghostQ.rows[0]!.locked_by).toBeNull();
    });
  });

  it('the reaper clears a stale lease on a non-running run without touching it (terminal → row deleted, queued → claim released)', async () => {
    await withPg('stale_reaper_refuses', async ({ pool }) => {
      await seedRun(pool, { id: 'run-completed', taskId: TASK_A, status: 'completed' }, NS);
      await seedQueueRow(pool, {
        runId: 'run-completed', lockedBy: 'w', leaseUntil: new Date(Date.now() - 3_600_000),
      }, NS);
      await seedRun(pool, { id: 'run-queued', taskId: TASK_A, status: 'queued' }, NS);
      await seedQueueRow(pool, {
        runId: 'run-queued', lockedBy: 'w', leaseUntil: new Date(Date.now() - 3_600_000),
      }, NS);

      const lines: string[] = [];
      const kernel = createKernel({ pool, logger: capturingLogger(lines) });
      const handle = kernel.startOrchestrator({
        namespaces: [NS],
        reaperIntervalMs: 30,
        waits: false,
        cron: false,
        workerOffline: false,
        stranded: false,
      });
      try {
        const deadline = Date.now() + 5_000;
        while (
          (await queueRowCount(pool, 'run-completed')) > 0 && Date.now() < deadline
        ) {
          await sleep(50);
        }
      } finally {
        handle.stop();
      }

      // Terminal: the stale queue row is DELETED, the run stays completed, no
      // recovery spent — the reaper must never transition a terminal run.
      expect(await runStatus(pool, 'run-completed')).toBe('completed');
      const completedRecoveries = await pool.query<{ r: number }>(
        `SELECT recoveries AS r FROM runs WHERE id = 'run-completed'`,
      );
      expect(completedRecoveries.rows[0]!.r).toBe(0);
      expect(await queueRowCount(pool, 'run-completed')).toBe(0);

      // Non-terminal desync: the stale claim is released, the run stays queued
      // and becomes claimable again — never flipped, never re-spent.
      expect(await runStatus(pool, 'run-queued')).toBe('queued');
      const queuedRecoveries = await pool.query<{ r: number }>(
        `SELECT recoveries AS r FROM runs WHERE id = 'run-queued'`,
      );
      expect(queuedRecoveries.rows[0]!.r).toBe(0);
      const q = await pool.query<{ locked_by: string | null; lease: Date | null }>(
        `SELECT locked_by, lease_until AS lease FROM queue WHERE run_id = 'run-queued'`,
      );
      expect(q.rows[0]!.locked_by).toBeNull();
      expect(q.rows[0]!.lease).toBeNull();

      expect(lines.some((m) => m.includes('[orchestrator:reaper]') && m.includes('stale lease'))).toBe(true);
    });
  });

  it('the reaper still requeues a genuinely running run whose lease expired (guard does not break the normal path)', async () => {
    await withPg('stale_reaper_healthy', async ({ kernel, pool }) => {
      const { workerId } = await kernel.registerWorker({
        codeVersion: 'v1', runtime: 'test', concurrency: 4, namespaces: [NS],
        tasks: [{ id: TASK_A, codeVersion: 'v1' }],
      });
      const { runId } = await kernel.trigger({ taskId: TASK_A, payload: {}, namespace: NS });
      const claim = await claimOne(kernel, {
        workerId, namespaces: [NS], taskIds: [TASK_A], leaseMs: 60,
      });
      expect(claim.id).toBe(runId);

      const handle = kernel.startOrchestrator({
        namespaces: [NS],
        reaperIntervalMs: 30,
        waits: false,
        cron: false,
        workerOffline: false,
        stranded: false,
      });
      try {
        const deadline = Date.now() + 5_000;
        while ((await runStatus(pool, runId)) === 'running' && Date.now() < deadline) {
          await sleep(50);
        }
      } finally {
        handle.stop();
      }

      expect(await runStatus(pool, runId)).toBe('queued');
      const rec = await pool.query<{ r: number }>(
        `SELECT recoveries AS r FROM runs WHERE id = $1`,
        [runId],
      );
      expect(rec.rows[0]!.r).toBe(1);
      const q = await pool.query<{ locked_by: string | null }>(
        `SELECT locked_by FROM queue WHERE run_id = $1`,
        [runId],
      );
      expect(q.rows[0]!.locked_by).toBeNull();
    });
  });

  it('100 rounds of cancel/complete/reaper/claim/timer interleaving: no terminal regression, no queue residue, no illegal fencing advance', async () => {
    await withPg('stale_interleave', async ({ kernel, pool }) => {
      const { workerId } = await kernel.registerWorker({
        codeVersion: 'v1', runtime: 'test', concurrency: 8, namespaces: [NS],
        tasks: [
          { id: TASK_A, codeVersion: 'v1' },
          { id: TASK_B, codeVersion: 'v1' },
        ],
      });
      // Both loops run for the whole suite — every round genuinely races them.
      const handle = kernel.startOrchestrator({
        namespaces: [NS],
        timerIntervalMs: 15,
        reaperIntervalMs: 15,
        cron: false,
        workerOffline: false,
        stranded: false,
      });
      try {
        const ROUNDS = 100;
        for (let i = 0; i < ROUNDS; i++) {
          // A: a timer wait whose resume the scanner races against a cancel.
          const { runId: aId } = await kernel.trigger({ taskId: TASK_A, payload: {}, namespace: NS });
          const aClaim = await claimOne(kernel, {
            workerId, namespaces: [NS], taskIds: [TASK_A], leaseMs: 60_000,
          });
          expect(aClaim.id).toBe(aId);
          const aToken = aClaim.fencingToken;
          const aResume = await kernel.suspendRun({
            runId: aId, namespace: NS, seq: 0, kind: 'duration',
            resumeAt: new Date(Date.now() + 30).toISOString(),
            fingerprint: 'fp-int', workerId, fencingToken: aToken,
          });
          expect(aResume.resumed).toBe(false);

          // B: a claim with a 80ms lease — the reaper's 15ms tick will reap it
          // mid-round, racing the terminal op fired below.
          const { runId: bId } = await kernel.trigger({ taskId: TASK_B, payload: {}, namespace: NS });
          const bClaim = await claimOne(kernel, {
            workerId, namespaces: [NS], taskIds: [TASK_B], leaseMs: 80,
          });
          expect(bClaim.id).toBe(bId);
          const bToken = bClaim.fencingToken;

          // Fire the round's ops together: a terminal op on A or B, and time
          // for the scanner + reaper to do their worst.
          const races: Promise<unknown>[] = [];
          if (i % 3 === 0) races.push(kernel.cancelRun(aId, NS));
          if (i % 3 === 1) races.push(kernel.cancelRun(bId, NS));
          if (i % 3 === 2) {
            races.push(
              kernel
                .completeRun({
                  runId: bId, output: {}, workerId, fencingToken: bToken, namespace: NS,
                })
                .then(
                  () => null,
                  () => null, // the reaper won: claim gone, token superseded
                ),
            );
          }
          races.push(sleep(160));
          await Promise.allSettled(races);

          // Drain A. 'queued' = the scanner won → reclaim (token must have
          // advanced — exactly one more claim) and complete. 'running' = the
          // suspend saw an already-past resumeAt (resumed:true) and kept the
          // claim. Anything else must be 'canceled' — and a canceled run must
          // show NO queue row and the SAME fencing token cancel saw (a terminal
          // run's token never advances again). 'waiting' is the scanner
          // mid-resume — poll it out (bounded) instead of asserting on a state
          // the scanner has not reached yet.
          const aStatus = await settleStatus(pool, aId, ['waiting']);
          if (aStatus === 'queued') {
            const a2 = await claimOne(kernel, {
              workerId, namespaces: [NS], taskIds: [TASK_A], leaseMs: 60_000, timeoutMs: 2_000,
            });
            expect(a2.id).toBe(aId);
            expect(a2.fencingToken).toBeGreaterThan(aToken);
            await kernel.completeRun({
              runId: aId, output: {}, workerId, fencingToken: a2.fencingToken, namespace: NS,
            });
          } else if (aStatus === 'running') {
            await kernel.completeRun({
              runId: aId, output: {}, workerId, fencingToken: aToken, namespace: NS,
            });
          } else {
            expect(aStatus).toBe('canceled');
            expect(await queueRowCount(pool, aId)).toBe(0);
            expect(await pendingWaitCount(pool, aId)).toBe(0);
            expect(await tokenOf(pool, aId)).toBe(aToken);
          }

          // Drain B: the 80ms lease expires mid-round and the reaper races the
          // terminal op fired above. Reaped → 'queued' (claim + complete);
          // terminal → no row. The reaper may be mid-tick when the sleep ends,
          // so poll 'running' out (bounded) rather than failing on a run the
          // reaper has not reached yet; a holdout reports the run id and its
          // stuck status instead of an opaque TERMINAL miss.
          const bStatus = await settleStatus(pool, bId, ['running']);
          if (bStatus === 'queued') {
            const b2 = await claimOne(kernel, {
              workerId, namespaces: [NS], taskIds: [TASK_B], leaseMs: 60_000, timeoutMs: 2_000,
            });
            expect(b2.id).toBe(bId);
            await kernel.completeRun({
              runId: bId, output: {}, workerId, fencingToken: b2.fencingToken, namespace: NS,
            });
          } else {
            expect(TERMINAL).toContain(bStatus);
            expect(await queueRowCount(pool, bId)).toBe(0);
          }

          // The committed state the round left must be fully consistent —
          // asserted BEFORE any cleanup so a transient desync is seen.
          await assertStaleInvariants(pool);
        }
      } finally {
        handle.stop();
      }

      // Final sweep: every row that ever existed is terminal and consistent.
      await assertStaleInvariants(pool);
      const leftover = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs WHERE status NOT IN ('completed','failed','canceled')`,
      );
      expect(leftover.rows[0]!.n).toBe(0);
    });
  }, 120_000);
});
