/* =============================================================================
   @better-trigger/kernel — suspendRun / waitForChildRun against a real Postgres.

   The suspend state machine: a run in flight hands its claim back to the
   scheduler by writing a waits row, flipping runs.status to 'waiting' and
   deleting its queue row — all in ONE transaction. This suite asserts those
   three effects land atomically, that an already-due wait never suspends
   (resumed:true, step row written, claim kept), that waitForChildRun creates
   the child and suspends the parent with the child enqueued, and that a stale
   fencing token cannot suspend at all.
   ============================================================================= */
import { expect, it } from 'vitest';
import { describePg, withPg, type PgContext } from './helpers';
import { StaleLeaseError } from '../../src/index';

const NS = { projectId: 'default', env: 'prod' };
const PARENT_TASK = 'suspend-parent-task';
const CHILD_TASK = 'suspend-child-task';

/** The worker-side view of a claim: the write credential (fencing token) plus
 *  the pieces every fenced call below re-scopes on. */
interface Claim {
  workerId: string;
  fencingToken: number;
  runId: string;
}

/** Register both tasks, trigger the parent and claim it — the starting point
 *  for every suspend scenario (mirrors the fencing suite's `claimedRun`). */
async function claimedRun(ctx: PgContext): Promise<Claim> {
  const { kernel } = ctx;
  const { workerId } = await kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: [
      { id: PARENT_TASK, codeVersion: 'v1' },
      { id: CHILD_TASK, codeVersion: 'v1' },
    ],
  });

  await kernel.trigger({ taskId: PARENT_TASK, payload: {}, namespace: NS });

  const claimed = await kernel.claimRuns({
    workerId,
    namespaces: [NS],
    taskIds: [PARENT_TASK],
    limit: 1,
    leaseMs: 60_000,
  });
  expect(claimed).toHaveLength(1);
  const c = claimed[0]!;
  return { workerId, fencingToken: c.fencingToken, runId: c.id };
}

describePg('suspend state machine', () => {
  it('suspendRun writes the wait, marks waiting and removes the queue row atomically', async () => {
    await withPg('suspend_suspend', async (ctx) => {
      const { kernel, pool } = ctx;
      const { workerId, fencingToken, runId } = await claimedRun(ctx);

      const resumeAt = new Date(Date.now() + 60_000).toISOString();
      const res = await kernel.suspendRun({
        runId,
        namespace: NS,
        seq: 0,
        kind: 'duration',
        resumeAt,
        fingerprint: 'fp1',
        workerId,
        fencingToken,
      });
      expect(res).toEqual({ resumed: false });

      const waits = await pool.query<{
        kind: string;
        status: string;
        resume_at: Date;
        fingerprint: string | null;
      }>(`SELECT kind, status, resume_at, fingerprint FROM waits WHERE run_id = $1`, [runId]);
      expect(waits.rows).toHaveLength(1);
      expect(waits.rows[0]!.kind).toBe('duration');
      expect(waits.rows[0]!.status).toBe('pending');
      // Clock contract (T1): a duration wait is stored as "this far from the
      // DATABASE clock", not as the host's absolute instant — the due-scan
      // judges `resume_at <= now()` on the DB clock, so the stored value must
      // sit ~60s after the DB's now() regardless of any host↔DB skew. Assert
      // the offset, not equality with the host-computed timestamp.
      const rel = await pool.query<{ secs: number }>(
        `SELECT extract(epoch FROM (resume_at - now()))::float AS secs
           FROM waits WHERE run_id = $1`,
        [runId],
      );
      expect(rel.rows[0]!.secs).toBeGreaterThan(55);
      expect(rel.rows[0]!.secs).toBeLessThanOrEqual(61);
      expect(waits.rows[0]!.fingerprint).toBe('fp1');

      const run = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId]);
      expect(run.rows[0]!.status).toBe('waiting');

      const queue = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM queue WHERE run_id = $1`,
        [runId],
      );
      expect(queue.rows[0]!.n).toBe(0);

      // Resume the way the wait-due orchestrator does (scanWaits): complete the
      // wait, stamp the completed step row with the declared fingerprint, flip
      // the run back to 'queued' and re-insert its queue row (priority comes off
      // the runs row) — then the run must be claimable again.
      const runRow = await pool.query<{ priority: number; concurrency_key: string | null }>(
        `SELECT priority, concurrency_key FROM runs WHERE id = $1`,
        [runId],
      );
      await pool.query(
        `UPDATE waits SET status = 'completed' WHERE run_id = $1 AND project_id = $2 AND env = $3`,
        [runId, NS.projectId, NS.env],
      );
      await pool.query(
        `INSERT INTO run_steps (run_id, seq, project_id, env, kind, label, status, output, error, attempt, started_at, finished_at, fingerprint)
         VALUES ($1, $2, $3, $4, 'wait', NULL, 'completed', NULL, NULL, 1, now(), now(), $5)`,
        [runId, 0, NS.projectId, NS.env, 'fp1'],
      );
      await pool.query(
        `UPDATE runs SET status = 'queued', updated_at = now() WHERE id = $1 AND project_id = $2 AND env = $3`,
        [runId, NS.projectId, NS.env],
      );
      await pool.query(
        `INSERT INTO queue (run_id, project_id, env, available_at, priority, concurrency_key)
         VALUES ($1, $2, $3, now(), $4, $5)`,
        [runId, NS.projectId, NS.env, runRow.rows[0]!.priority, runRow.rows[0]!.concurrency_key],
      );

      const reclaimed = await kernel.claimRuns({
        workerId,
        namespaces: [NS],
        taskIds: [PARENT_TASK],
        limit: 1,
        leaseMs: 60_000,
      });
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.id).toBe(runId);
    });
  });

  it('resumeAt already past → resumed:true, step row lands, claim preserved', async () => {
    await withPg('suspend_resumed', async (ctx) => {
      const { kernel, pool } = ctx;
      const { workerId, fencingToken, runId } = await claimedRun(ctx);

      const res = await kernel.suspendRun({
        runId,
        namespace: NS,
        seq: 0,
        kind: 'duration',
        resumeAt: new Date(Date.now() - 60_000).toISOString(),
        fingerprint: 'fp1',
        workerId,
        fencingToken,
      });
      expect(res).toEqual({ resumed: true });

      const steps = await pool.query<{ kind: string; status: string; fingerprint: string | null }>(
        `SELECT kind, status, fingerprint FROM run_steps WHERE run_id = $1 AND seq = $2`,
        [runId, 0],
      );
      expect(steps.rows).toHaveLength(1);
      expect(steps.rows[0]!.kind).toBe('wait');
      expect(steps.rows[0]!.status).toBe('completed');
      expect(steps.rows[0]!.fingerprint).toBe('fp1');

      const run = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId]);
      expect(run.rows[0]!.status).toBe('running');

      // The claim was kept: the queue row still exists and is still this
      // worker's. No waits row was ever written.
      const queue = await pool.query<{ n: number; locked_by: string | null }>(
        `SELECT count(*)::int AS n, max(locked_by) AS locked_by FROM queue WHERE run_id = $1`,
        [runId],
      );
      expect(queue.rows[0]!.n).toBe(1);
      expect(queue.rows[0]!.locked_by).toBe(workerId);

      const waits = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM waits WHERE run_id = $1`,
        [runId],
      );
      expect(waits.rows[0]!.n).toBe(0);
    });
  });

  it('waitForChildRun creates the child and suspends the parent', async () => {
    await withPg('suspend_child', async (ctx) => {
      const { kernel, pool } = ctx;
      const { workerId, fencingToken, runId } = await claimedRun(ctx);

      const payload = { n: 42 };
      const res = await kernel.waitForChildRun({
        runId,
        namespace: NS,
        seq: 0,
        label: 'spawn child',
        taskId: CHILD_TASK,
        payload,
        fingerprint: 'fp2',
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

      // The child is enqueued, the parent's queue row is gone.
      const queues = await pool.query<{ run_id: string }>(`SELECT run_id FROM queue`);
      expect(queues.rows).toHaveLength(1);
      expect(queues.rows[0]!.run_id).toBe(res.childRunId);

      const waits = await pool.query<{
        kind: string;
        status: string;
        child_run_id: string | null;
        fingerprint: string | null;
      }>(`SELECT kind, status, child_run_id, fingerprint FROM waits WHERE run_id = $1`, [runId]);
      expect(waits.rows).toHaveLength(1);
      expect(waits.rows[0]!.kind).toBe('run');
      expect(waits.rows[0]!.status).toBe('pending');
      expect(waits.rows[0]!.child_run_id).toBe(res.childRunId);
      expect(waits.rows[0]!.fingerprint).toBe('fp2');
    });
  });

  it('fenced: stale token cannot suspend', async () => {
    await withPg('suspend_fenced', async (ctx) => {
      const { kernel, pool } = ctx;
      const { workerId, fencingToken, runId } = await claimedRun(ctx);

      // Bump the token by handing the claim back and reclaiming — the run is
      // now held under a newer token, so the old one must be refused.
      await kernel.releaseClaims({ workerId, namespaces: [NS] });
      const reclaimed = await kernel.claimRuns({
        workerId,
        namespaces: [NS],
        taskIds: [PARENT_TASK],
        limit: 1,
        leaseMs: 60_000,
      });
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.fencingToken).toBeGreaterThan(fencingToken);

      await expect(
        kernel.suspendRun({
          runId,
          namespace: NS,
          seq: 0,
          kind: 'duration',
          resumeAt: new Date(Date.now() + 60_000).toISOString(),
          fingerprint: 'fp3',
          workerId,
          fencingToken, // stale — the claim now lives under a newer token
        }),
      ).rejects.toBeInstanceOf(StaleLeaseError);

      // Nothing was written: no waits row, run still running under the new claim.
      const waits = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM waits WHERE run_id = $1`,
        [runId],
      );
      expect(waits.rows[0]!.n).toBe(0);

      const run = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId]);
      expect(run.rows[0]!.status).toBe('running');
    });
  });
});
