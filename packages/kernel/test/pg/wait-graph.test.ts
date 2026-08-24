/* =============================================================================
   @better-trigger/kernel — wait-graph invariants (todos/p1-37) against a real
   Postgres.

   triggerAndWait used to accept the ordinary GLOBAL idempotency key, which let
   one child be shared across parents (or be the parent itself) — and the wake
   path only resolved rows[0], so shared children stranded every other waiter
   and terminal children parked their parents forever. The contract now is:

     - waitForChildRun REFUSES options.idempotencyKey (bad_request): the
       child's identity is the parent's durable step (parent run id + step_seq),
       enforced by the pending-step unique index on waits;
     - wakeParentIfWaiting resolves ALL pending waiters (id ASC) with an
       expected-status predicate on the parent flip;
     - terminal paths wake unconditionally — parent_run_id is lineage, not a
       waiter registry;
     - attach/complete/fail/cancel interleave freely without ever leaving a
       pending wait on a terminal child, and no cycle can form via the API.

   This suite asserts all of that against the real engine. Worker registration
   is real where a claim is needed; the multi-waiter and terminal-replay cases
   seed their shapes directly with SQL, like the orphan-waits suite.
   ============================================================================= */
import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Namespace } from '@better-trigger/core';
import { describePg, withPg, type PgContext } from './helpers';
import { createKernel, KernelError, RunNotRunningError, type Kernel, type KernelLogger } from '../../src/index';

const NS = { projectId: 'default', env: 'prod' };
const TASK_A = 'wait-graph-a';
const TASK_B = 'wait-graph-b';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Claim exactly one run with bounded retry — trigger stamps available_at
 *  from the host clock while the claim predicate compares against the
 *  database's now(), so a sub-millisecond skew between the two can make a
 *  freshly created run briefly invisible to claim and `claimRuns(...)[0]!`
 *  throw a TypeError on a perfectly healthy run. Retrying a short window
 *  absorbs the skew without weakening any race under test. */
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

/** Register both tasks; every scenario starts with this. */
async function register(ctx: PgContext): Promise<string> {
  const { workerId } = await ctx.kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: [
      { id: TASK_A, codeVersion: 'v1' },
      { id: TASK_B, codeVersion: 'v1' },
    ],
  });
  return workerId;
}

interface Claim {
  id: string;
  fencingToken: number;
}

/** Trigger `taskId` and claim its single queued run (each scenario keeps the
 *  queue drained, so limit 1 is deterministic; the bounded retry absorbs the
 *  host-clock vs db-clock available_at skew on the fresh trigger). */
async function triggerAndClaim(
  ctx: PgContext,
  workerId: string,
  taskId: string,
): Promise<Claim> {
  await ctx.kernel.trigger({ taskId, payload: {}, namespace: NS });
  return claimOne(ctx.kernel, { workerId, namespaces: [NS], taskIds: [taskId], leaseMs: 60_000 });
}

/** The p1-37 invariant pair: no pending wait on a terminal child, and no
 *  'waiting' run without a pending wait. One MVCC snapshot per assert. */
async function assertWaitGraphInvariants(pool: Pool): Promise<void> {
  const bad = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM waits w JOIN runs c ON c.id = w.child_run_id
      WHERE w.status = 'pending' AND w.kind = 'run' AND w.child_run_id IS NOT NULL
        AND c.status IN ('completed','failed','canceled')
        AND w.project_id = $1 AND w.env = $2`,
    [NS.projectId, NS.env],
  );
  expect(bad.rows[0]!.n).toBe(0);
  const stranded = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM runs r
      WHERE r.status = 'waiting' AND r.project_id = $1 AND r.env = $2
        AND NOT EXISTS (
          SELECT 1 FROM waits w WHERE w.run_id = r.id AND w.status = 'pending'
        )`,
    [NS.projectId, NS.env],
  );
  expect(stranded.rows[0]!.n).toBe(0);
}

describePg('wait-graph invariants (p1-37)', () => {
  it('waitForChildRun refuses a global idempotencyKey (bad_request); plain trigger idempotency is untouched', async () => {
    await withPg('wg_bad_key', async (ctx) => {
      const { kernel, pool } = ctx;
      const workerId = await register(ctx);
      const parent = await triggerAndClaim(ctx, workerId, TASK_A);

      const err = await kernel
        .waitForChildRun({
          runId: parent.id,
          namespace: NS,
          seq: 0,
          taskId: TASK_B,
          payload: {},
          // The old self-loop spell: reuse a global key from inside the run.
          options: { idempotencyKey: 'k-any' },
          fingerprint: 'fp-1',
          workerId,
          fencingToken: parent.fencingToken,
        })
        .then(
          () => {
            throw new Error('waitForChildRun should have rejected');
          },
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(KernelError);
      expect(err).toMatchObject({ code: 'bad_request' });
      // A refused key is a plain parameter error, NOT a cycle refusal: no
      // graph edge was ever in danger of forming, so the cycle defense counter
      // must stay untouched (it is reserved for a real attach-time refusal —
      // the defensive fresh-child id collision).
      expect(kernel.waitGraph.cycleRejected).toBe(0);

      // Nothing happened: the parent is still running and nothing was written.
      const run = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [
        parent.id,
      ]);
      expect(run.rows[0]!.status).toBe('running');
      const waits = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM waits WHERE run_id = $1`,
        [parent.id],
      );
      expect(waits.rows[0]!.n).toBe(0);
      const children = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs WHERE task_id = $1`,
        [TASK_B],
      );
      expect(children.rows[0]!.n).toBe(0);

      // Ordinary global idempotency is unaffected by the durable-wait change.
      const a = await kernel.trigger({
        taskId: TASK_A,
        payload: {},
        namespace: NS,
        options: { idempotencyKey: 'k-global' },
      });
      const b = await kernel.trigger({
        taskId: TASK_A,
        payload: {},
        namespace: NS,
        options: { idempotencyKey: 'k-global' },
      });
      expect(b.runId).toBe(a.runId);
      expect(b.idempotent).toBe(true);
    });
  });

  it('a step whose child is already terminal replays the recorded result without suspending the parent again', async () => {
    await withPg('wg_terminal_replay', async (ctx) => {
      const { kernel, pool } = ctx;
      const workerId = await register(ctx);
      const parent = await triggerAndClaim(ctx, workerId, TASK_A);

      const first = await kernel.waitForChildRun({
        runId: parent.id,
        namespace: NS,
        seq: 0,
        taskId: TASK_B,
        payload: { n: 1 },
        fingerprint: 'fp-ok',
        workerId,
        fencingToken: parent.fencingToken,
      });

      // Construct the post-wake world directly (the todo's "SQL-constructed
      // completed state"): the child went terminal, the wake wrote the parent's
      // step row and resolved the wait, and the parent was claimed again.
      await pool.query(
        `UPDATE runs SET status = 'completed', output = '{"n":1}'::jsonb, finished_at = now()
          WHERE id = $1`,
        [first.childRunId],
      );
      await pool.query(
        `UPDATE waits SET status = 'completed' WHERE run_id = $1 AND step_seq = 0 AND kind = 'run'`,
        [parent.id],
      );
      await pool.query(
        `INSERT INTO run_steps (run_id, project_id, env, seq, kind, status, output, attempt)
         VALUES ($1,$2,$3,0,'trigger-and-wait','completed',
                 jsonb_build_object('id', $4::text, 'ok', true, 'output', jsonb_build_object('n', 1)), 1)`,
        [parent.id, NS.projectId, NS.env, first.childRunId],
      );
      await pool.query(`UPDATE runs SET status = 'running' WHERE id = $1`, [parent.id]);
      await pool.query(
        `INSERT INTO queue (run_id, project_id, env, available_at, locked_by)
         VALUES ($1, $2, $3, now(), $4)`,
        [parent.id, NS.projectId, NS.env, workerId],
      );

      // The replay: the executor's snapshot missed the step and re-invoked the
      // durable call. It must hand back the recorded child, NOT create a second
      // one and NOT suspend the parent.
      const replay = await kernel.waitForChildRun({
        runId: parent.id,
        namespace: NS,
        seq: 0,
        taskId: TASK_B,
        payload: { n: 1 },
        fingerprint: 'fp-ok',
        workerId,
        fencingToken: parent.fencingToken,
      });
      expect(replay.childRunId).toBe(first.childRunId);

      const run = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [
        parent.id,
      ]);
      expect(run.rows[0]!.status).toBe('running'); // never flipped to waiting
      const waits = await pool.query<{ n: number; s: string | null }>(
        `SELECT count(*)::int AS n, max(status) AS s FROM waits WHERE run_id = $1`,
        [parent.id],
      );
      expect(waits.rows[0]!.n).toBe(1);
      expect(waits.rows[0]!.s).toBe('completed');
      const children = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs WHERE task_id = $1`,
        [TASK_B],
      );
      expect(children.rows[0]!.n).toBe(1);
    });
  });

  it('concurrent replays of one step produce at most one pending wait and one child', async () => {
    await withPg('wg_concurrent_replay', async (ctx) => {
      const { kernel, pool } = ctx;
      const workerId = await register(ctx);
      const parent = await triggerAndClaim(ctx, workerId, TASK_A);

      const call = () =>
        kernel.waitForChildRun({
          runId: parent.id,
          namespace: NS,
          seq: 0,
          taskId: TASK_B,
          payload: {},
          fingerprint: 'fp-race',
          workerId,
          fencingToken: parent.fencingToken,
        });
      const results = await Promise.allSettled([call(), call()]);

      // Exactly one wins. The loser re-runs fencing and finds the parent no
      // longer running — the parent's queue row is the serialization point, so
      // a second attach can never pass assertOwnedRunning.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RunNotRunningError);
      const childRunId = (fulfilled[0] as PromiseFulfilledResult<{ childRunId: string }>).value
        .childRunId;

      const waits = await pool.query<{ n: number; s: string | null }>(
        `SELECT count(*)::int AS n, max(status) AS s FROM waits WHERE run_id = $1`,
        [parent.id],
      );
      expect(waits.rows[0]!.n).toBe(1);
      expect(waits.rows[0]!.s).toBe('pending');
      const children = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs WHERE task_id = $1 AND parent_run_id = $2`,
        [TASK_B, parent.id],
      );
      expect(children.rows[0]!.n).toBe(1);

      // The pending-step unique index is the structural backstop: even a
      // hand-written second pending wait for the same (run, step, kind) is
      // refused by the database itself.
      const dup = await pool
        .query(
          `INSERT INTO waits (run_id, project_id, env, step_seq, kind, child_run_id, status)
           VALUES ($1, $2, $3, 0, 'run', $4, 'pending')`,
          [parent.id, NS.projectId, NS.env, childRunId],
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(dup).not.toBeNull();
      expect((dup as { code?: string }).code).toBe('23505');

      // The single child resolving still wakes the parent.
      const child = await claimOne(ctx.kernel, {
        workerId,
        namespaces: [NS],
        taskIds: [TASK_B],
        leaseMs: 60_000,
      });
      expect(child.id).toBe(childRunId);
      await kernel.completeRun({
        runId: child.id,
        output: { ok: true },
        workerId,
        fencingToken: child.fencingToken,
        namespace: NS,
      });
      const run = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [
        parent.id,
      ]);
      expect(run.rows[0]!.status).toBe('queued');
      const step = await pool.query<{ output: unknown }>(
        `SELECT output FROM run_steps WHERE run_id = $1 AND seq = 0`,
        [parent.id],
      );
      expect(step.rows[0]!.output).toMatchObject({ id: childRunId, ok: true });
    });
  });

  it('a raw same-step conflict blocks the pending-wait INSERT, rolls the loser back, and re-reads the winner (ON CONFLICT 23505 path)', async () => {
    await withPg('wg_conflict_reread', async (ctx) => {
      const { kernel, pool } = ctx;
      const workerId = await register(ctx);
      const parent = await triggerAndClaim(ctx, workerId, TASK_A);

      // The winner: an open transaction holding a conflicting pending wait for
      // (parent, seq 0, 'run'). The FK on waits.run_id would normally take
      // FOR KEY SHARE on the parent's runs row and block the public call's own
      // lockRunRow FOR UPDATE before it ever reached the unique index —
      // skipping FK triggers on this raw client leaves the row conflict-free
      // EXCEPT for the unique index, which is exactly the race under test
      // (partial unique indexes stay enforced under replica role).
      const winnerChildId = 'winner-child'; // the winner's child id (fake, no run row)
      const raw = await pool.connect();
      try {
        await raw.query(`SET session_replication_role = replica`);
        await raw.query('BEGIN');
        await raw.query(
          `INSERT INTO waits (run_id, project_id, env, step_seq, kind, child_run_id, fingerprint, status)
           VALUES ($1, $2, $3, 0, 'run', $4, 'fp-winner', 'pending')`,
          [parent.id, NS.projectId, NS.env, winnerChildId],
        );

        // The loser: the PUBLIC call for the same (run, seq). assertOwnedRunning
        // passes (parent running, no conflicting lock held), readExistingChildRunId
        // cannot see the uncommitted winner row, a child is created, and the
        // waits INSERT parks on the unique index until the winner settles.
        let settled: 'blocked' | 'done' = 'blocked';
        const loser = kernel
          .waitForChildRun({
            runId: parent.id,
            namespace: NS,
            seq: 0,
            taskId: TASK_B,
            payload: {},
            fingerprint: 'fp-loser',
            workerId,
            fencingToken: parent.fencingToken,
          })
          .then((res) => {
            settled = 'done';
            return res;
          });

        // Genuinely blocked at the unique index — not resolved within the race
        // window, so the winner must still hold the uncommitted conflict.
        const race = await Promise.race([
          loser.then(() => 'done' as const),
          sleep(500).then(() => 'blocked' as const),
        ]);
        expect(race).toBe('blocked');
        expect(settled).toBe('blocked');

        // Winner commits → the conflict resolves to a committed row → ON
        // CONFLICT DO NOTHING yields no row → PendingWaitConflictError → the
        // loser's whole tx rolls back (its freshly created child included) →
        // the catch branch re-reads the winner's committed wait.
        await raw.query('COMMIT');
        const res = await loser;
        expect(settled).toBe('done');
        expect(res.childRunId).toBe(winnerChildId);
      } finally {
        // Close any still-open tx FIRST, then clear the replica role, then
        // hand the connection back: ROLLBACK would undo a RESET issued inside
        // the open tx, so ordering matters — a leaked replica role would
        // silently disable FK enforcement for later tests on this connection.
        await raw.query('ROLLBACK').catch(() => {});
        await raw.query(`RESET session_replication_role`).catch(() => {});
        raw.release();
      }

      // Exactly one pending wait for (parent, seq 0, 'run') — the winner's,
      // carrying the winner's child id and fingerprint.
      const waits = await pool.query<{ n: number; child: string | null; fp: string | null }>(
        `SELECT count(*)::int AS n, max(child_run_id) AS child, max(fingerprint) AS fp
           FROM waits WHERE run_id = $1 AND step_seq = 0 AND kind = 'run' AND status = 'pending'`,
        [parent.id],
      );
      expect(waits.rows[0]).toMatchObject({ n: 1, child: winnerChildId, fp: 'fp-winner' });

      // The parent carries the winner's committed state — the loser's tx left
      // no trace: still 'running', still claimed by us, queue row intact.
      const run = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [
        parent.id,
      ]);
      expect(run.rows[0]!.status).toBe('running');
      const queue = await pool.query<{ n: number; locked_by: string | null }>(
        `SELECT count(*)::int AS n, max(locked_by) AS locked_by FROM queue WHERE run_id = $1`,
        [parent.id],
      );
      expect(queue.rows[0]!.n).toBe(1);
      expect(queue.rows[0]!.locked_by).toBe(workerId);

      // No orphan child run: the loser's child died with its rolled-back tx,
      // and the winner's fake child id never had a row — only the parent.
      const children = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs WHERE task_id = $1`,
        [TASK_B],
      );
      expect(children.rows[0]!.n).toBe(0);
      const allRuns = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM runs`);
      expect(allRuns.rows[0]!.n).toBe(1);
    });
  });

  it('a terminal child followed by a late pending wait (linearization hole, raw SQL) is OBSERVED by the scanner gauge', async () => {
    await withPg('wg_stuck_observed', async (ctx) => {
      const { pool } = ctx;
      await register(ctx);

      // SQL-constructed stale combination — the interleave a healthy engine
      // can never commit, built exactly the way a real terminal tx locks: tx A
      // holds the child's runs row FOR UPDATE (canonical position 2) while it
      // flips the child to terminal; tx B's wait INSERT takes FOR KEY SHARE on
      // the child row via the waits FK, which CONFLICTS with A's FOR UPDATE,
      // so B parks until A commits — and lands after A's pending-wait scan is
      // already past. Result: a pending 'run' wait on an already-terminal
      // child, with no further terminal event to ever fire.
      await pool.query(
        `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type, parent_run_id)
         VALUES ($1, $2, $3, $4, 'waiting', 'api', NULL)`,
        ['stuck-parent', NS.projectId, NS.env, TASK_A],
      );
      await pool.query(
        `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type, parent_run_id)
         VALUES ($1, $2, $3, $4, 'queued', 'subtask', $5)`,
        ['stuck-child', NS.projectId, NS.env, TASK_B, 'stuck-parent'],
      );

      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        await a.query(`SELECT id FROM runs WHERE id = 'stuck-child' FOR UPDATE`);
        await a.query(
          `UPDATE runs SET status = 'completed', finished_at = now() WHERE id = 'stuck-child'`,
        );

        let bLanded: 'blocked' | 'done' = 'blocked';
        const bInsert = b
          .query(
            `INSERT INTO waits (run_id, project_id, env, step_seq, kind, child_run_id, fingerprint, status)
             VALUES ('stuck-parent', $1, $2, 0, 'run', 'stuck-child', 'fp-stuck', 'pending') RETURNING id`,
            [NS.projectId, NS.env],
          )
          .then(() => {
            bLanded = 'done';
          });
        const race = await Promise.race([
          bInsert.then(() => 'done' as const),
          sleep(500).then(() => 'blocked' as const),
        ]);
        expect(race).toBe('blocked');
        expect(bLanded).toBe('blocked');

        await a.query('COMMIT');
        await bInsert;
        expect(bLanded).toBe('done');
      } finally {
        a.release();
        b.release();
      }

      // The stale row exists, exactly once.
      const stuck = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM waits w
           WHERE w.kind = 'run' AND w.status = 'pending' AND w.child_run_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM runs c
                WHERE c.id = w.child_run_id
                  AND c.status IN ('completed','failed','canceled')
             )`,
      );
      expect(stuck.rows[0]!.n).toBe(1);

      // The wait-due scanner's gauge observes it — and it is a GAUGE: a stable
      // 1 tick after tick (the transition is logged once), not a rate that
      // climbs by one every tick. A fresh kernel over the same pool so the
      // violation log is capturable instead of spamming the console.
      const errors: string[] = [];
      const logger: KernelLogger = {
        warn: () => {},
        error: (...args: unknown[]) => errors.push(String(args[0])),
      };
      const observing = createKernel({ pool, logger });
      const orch = observing.startOrchestrator({
        namespaces: [NS],
        timerIntervalMs: 50,
        cron: false,
        reaper: false,
        workerOffline: false,
      });
      try {
        const deadline = Date.now() + 3_000;
        while (observing.waitGraph.terminalChildPendingWait !== 1) {
          if (Date.now() > deadline) {
            throw new Error(
              `scanner gauge never observed the stuck wait (got ` +
                `${observing.waitGraph.terminalChildPendingWait})`,
            );
          }
          await sleep(20);
        }
        // Several more ticks later it is STILL exactly 1: per-tick assignment,
        // not accumulation (the old += would read ~1 + ticks elapsed).
        await sleep(300);
        expect(observing.waitGraph.terminalChildPendingWait).toBe(1);
        // The parent HAS a pending wait, so the other gauge stays clear.
        expect(observing.waitGraph.waitingWithoutPendingWait).toBe(0);
        // The scanner said it out loud (transition log, once).
        expect(errors.some((m) => m.includes('wait-graph') && m.includes('pending wait'))).toBe(
          true,
        );
      } finally {
        orch.stop();
      }
    });
  });

  it('a child going terminal resolves ALL pending waiters and re-enqueues every parent', async () => {
    await withPg('wg_multi_waiter', async (ctx) => {
      const { kernel, pool } = ctx;
      const workerId = await register(ctx);
      const child = await triggerAndClaim(ctx, workerId, TASK_B);

      // Three parents, each waiting on the same child (SQL-constructed — the
      // public API can no longer share a child, but a shared child must still
      // resolve every waiter if one ever exists).
      const N = 3;
      for (let i = 0; i < N; i++) {
        await pool.query(
          `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type, parent_run_id)
           VALUES ($1, $2, $3, $4, 'waiting', 'api', $5)`,
          [`parent-${i}`, NS.projectId, NS.env, TASK_A, child.id],
        );
        await pool.query(
          `INSERT INTO waits (run_id, project_id, env, step_seq, kind, child_run_id, fingerprint, status)
           VALUES ($1, $2, $3, 0, 'run', $4, $5, 'pending')`,
          [`parent-${i}`, NS.projectId, NS.env, child.id, `fp-${i}`],
        );
      }

      await kernel.completeRun({
        runId: child.id,
        output: { n: 7 },
        workerId,
        fencingToken: child.fencingToken,
        namespace: NS,
      });

      for (let i = 0; i < N; i++) {
        const run = await pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [`parent-${i}`],
        );
        expect(run.rows[0]!.status).toBe('queued');
        const queue = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM queue WHERE run_id = $1`,
          [`parent-${i}`],
        );
        expect(queue.rows[0]!.n).toBe(1);
        const wait = await pool.query<{ s: string }>(
          `SELECT status AS s FROM waits WHERE run_id = $1 AND step_seq = 0 AND kind = 'run'`,
          [`parent-${i}`],
        );
        expect(wait.rows[0]!.s).toBe('completed');
        const step = await pool.query<{ output: unknown; fingerprint: string | null }>(
          `SELECT output, fingerprint FROM run_steps WHERE run_id = $1 AND seq = 0`,
          [`parent-${i}`],
        );
        expect(step.rows[0]!.output).toEqual({ id: child.id, ok: true, output: { n: 7 } });
        expect(step.rows[0]!.fingerprint).toBe(`fp-${i}`);
      }

      // The child itself is terminal with no queue row left.
      const childRow = await pool.query<{ status: string }>(
        `SELECT status FROM runs WHERE id = $1`,
        [child.id],
      );
      expect(childRow.rows[0]!.status).toBe('completed');
      const childQueue = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM queue WHERE run_id = $1`,
        [child.id],
      );
      expect(childQueue.rows[0]!.n).toBe(0);
      await assertWaitGraphInvariants(pool);
    });
  });

  it('every round races a terminal child against a parent-side op — never a pending wait on a terminal child (100 rounds)', async () => {
    await withPg('wg_interleave', async (ctx) => {
      const { kernel, pool } = ctx;
      const workerId = await register(ctx);

      for (let i = 0; i < 100; i++) {
        const parent = await triggerAndClaim(ctx, workerId, TASK_A);

        // Suspend the parent on the durable step: the attach creates the child.
        const attach = await kernel.waitForChildRun({
          runId: parent.id,
          namespace: NS,
          seq: 0,
          taskId: TASK_B,
          payload: {},
          fingerprint: 'fp-int',
          workerId,
          fencingToken: parent.fencingToken,
        });

        // Claim the child so its terminal write is a REAL transaction (queue →
        // child run row → parent rows) racing the parent-side op below.
        const child = await claimOne(kernel, {
          workerId,
          namespaces: [NS],
          taskIds: [TASK_B],
          leaseMs: 60_000,
        });
        expect(child.id).toBe(attach.childRunId);

        // EVERY round is a true concurrent interleave, fired together:
        // one terminal op on the running child × one parent-side op.
        const terminal =
          i % 3 === 0
            ? kernel.completeRun({
                runId: child.id,
                output: { n: i },
                workerId,
                fencingToken: child.fencingToken,
                namespace: NS,
              })
            : i % 3 === 1
              ? kernel.failRun({
                  runId: child.id,
                  error: { message: 'boom' },
                  abort: true,
                  workerId,
                  fencingToken: child.fencingToken,
                  namespace: NS,
                })
              : kernel.cancelRun(child.id, NS);
        const parentSide =
          i % 2 === 0
            ? kernel.cancelRun(parent.id, NS)
            : // Replay attach: the parent is 'waiting' (no queue row), so the
              // replay must be refused (run_not_running / stale_lease) while
              // the child's terminal tx may be mid-wake on the parent's rows —
              // the two write sets overlap exactly there.
              kernel
                .waitForChildRun({
                  runId: parent.id,
                  namespace: NS,
                  seq: 0,
                  taskId: TASK_B,
                  payload: {},
                  fingerprint: 'fp-int',
                  workerId,
                  fencingToken: parent.fencingToken,
                })
                .then(
                  () => null,
                  () => null,
                );

        await Promise.allSettled([terminal, parentSide]);

        // The invariant must hold in the committed state the race left —
        // asserted BEFORE any cleanup so a transient wake-miss is seen.
        await assertWaitGraphInvariants(pool);

        // Drain: whatever the race left behind, drive it to a clean terminal
        // so the next round starts from an empty queue.
        const childRow = await pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [child.id],
        );
        if (!['completed', 'failed', 'canceled'].includes(childRow.rows[0]!.status)) {
          await kernel.cancelRun(child.id, NS);
        }
        const parentRow = await pool.query<{ status: string }>(
          `SELECT status FROM runs WHERE id = $1`,
          [parent.id],
        );
        if (parentRow.rows[0]!.status === 'queued') {
          // The child's terminal tx won and re-enqueued the parent: claim and
          // complete it.
          const woken = await claimOne(kernel, {
            workerId,
            namespaces: [NS],
            taskIds: [TASK_A],
            leaseMs: 60_000,
            timeoutMs: 2_000,
          });
          expect(woken.id).toBe(parent.id);
          await kernel.completeRun({
            runId: parent.id,
            output: {},
            workerId,
            fencingToken: woken.fencingToken,
            namespace: NS,
          });
        }

        await assertWaitGraphInvariants(pool);
      }
    });
  }, 120_000);

  it('no cycle can form through the public API: A→B→fresh-child resolves, and no wait ever points at its own run', async () => {
    await withPg('wg_no_cycles', async (ctx) => {
      const { kernel, pool } = ctx;
      const workerId = await register(ctx);

      // A's step waits on task B → fresh child B (never A itself).
      const a = await triggerAndClaim(ctx, workerId, TASK_A);
      const waitA = await kernel.waitForChildRun({
        runId: a.id,
        namespace: NS,
        seq: 0,
        taskId: TASK_B,
        payload: {},
        fingerprint: 'fp-a',
        workerId,
        fencingToken: a.fencingToken,
      });
      const b = waitA.childRunId;
      expect(b).not.toBe(a.id);

      // B's own step waits on task A → ANOTHER fresh child, never A.
      const bClaim = await claimOne(kernel, {
        workerId,
        namespaces: [NS],
        taskIds: [TASK_B],
        leaseMs: 60_000,
      });
      const waitB = await kernel.waitForChildRun({
        runId: b,
        namespace: NS,
        seq: 0,
        taskId: TASK_A,
        payload: {},
        fingerprint: 'fp-b',
        workerId,
        fencingToken: bClaim.fencingToken,
      });
      const a2 = waitB.childRunId;
      expect(a2).not.toBe(a.id);
      expect(a2).not.toBe(b);

      // No wait row points at its own run — self-loops are structurally absent.
      const selfRef = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM waits w WHERE w.child_run_id = w.run_id`,
      );
      expect(selfRef.rows[0]!.n).toBe(0);

      // Unwind the chain: complete A2 → wakes B → complete B → wakes A.
      const a2Claim = await claimOne(kernel, {
        workerId,
        namespaces: [NS],
        taskIds: [TASK_A],
        leaseMs: 60_000,
      });
      expect(a2Claim.id).toBe(a2);
      await kernel.completeRun({
        runId: a2,
        output: { done: 'a2' },
        workerId,
        fencingToken: a2Claim.fencingToken,
        namespace: NS,
      });

      const bAgain = await claimOne(kernel, {
        workerId,
        namespaces: [NS],
        taskIds: [TASK_B],
        leaseMs: 60_000,
      });
      expect(bAgain.id).toBe(b);
      await kernel.completeRun({
        runId: b,
        output: { done: 'b' },
        workerId,
        fencingToken: bAgain.fencingToken,
        namespace: NS,
      });

      const aAgain = await claimOne(kernel, {
        workerId,
        namespaces: [NS],
        taskIds: [TASK_A],
        leaseMs: 60_000,
      });
      expect(aAgain.id).toBe(a.id);
      await kernel.completeRun({
        runId: a.id,
        output: { done: 'a' },
        workerId,
        fencingToken: aAgain.fencingToken,
        namespace: NS,
      });

      // Everything reached a terminal state through its own resolution — the
      // chain A→B→A2 is a DAG, and the step rows carry the exact lineage.
      const stepA = await pool.query<{ output: unknown }>(
        `SELECT output FROM run_steps WHERE run_id = $1 AND seq = 0`,
        [a.id],
      );
      expect(stepA.rows[0]!.output).toMatchObject({ id: b, ok: true });
      const stepB = await pool.query<{ output: unknown }>(
        `SELECT output FROM run_steps WHERE run_id = $1 AND seq = 0`,
        [b],
      );
      expect(stepB.rows[0]!.output).toMatchObject({ id: a2, ok: true });
      await assertWaitGraphInvariants(pool);
    });
  });
});
