/* =============================================================================
   @better-trigger/kernel — manual-retry operation idempotency (p2-38).

   POST /runs/:id/retry had no request-level idempotency: a replayed request
   (client timeout re-send, proxy retry, double click) read the same terminal
   source run and minted one `trigger_type='retry'` run per delivery. With an
   operation key the retry is now recorded in run_retry_operations under
   (project_id, env, source_run_id, operation_key) and a replay returns the
   FIRST call's new run id; no key keeps the legacy semantics.

   These suites run against real Postgres (skipped without DATABASE_URL) so the
   lock ordering and the unique-index defense path — not just the SQL text —
   are what gets asserted. Note the one 23505 case here is NOT the main
   concurrency path: same-key writers serialize on the source runs row lock
   (the FK's KEY SHARE check conflicts with FOR UPDATE), so the committed-row
   replay branch handles them. The unique-index branch is defense-in-depth,
   exercised by deliberately bypassing the FK via session_replication_role.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import type { Namespace } from '@better-trigger/core';
import type { Kernel } from '../../src/index';
import { describePg, withPg } from './helpers';

const ns = { projectId: 'default', env: 'prod' };

/** Register `taskId` once and return a CANCELED run of it (a retryable source). */
async function makeCanceledSource(kernel: Kernel, taskId: string, namespace: Namespace): Promise<string> {
  const { runId } = await kernel.trigger({ taskId, payload: { n: 1 }, namespace });
  await kernel.cancelRun(runId, namespace);
  return runId;
}

async function registerTask(kernel: Kernel, taskId: string, namespaces: Namespace[]): Promise<void> {
  await kernel.registerWorker({
    codeVersion: 'v1',
    runtime: 'test',
    concurrency: 1,
    namespaces,
    tasks: [{ id: taskId, codeVersion: 'v1' }],
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describePg('retry operation idempotency', () => {
  it('two concurrent retries with the same key return the same run and record one operation', async () => {
    await withPg('retry_same_key_concurrent', async ({ kernel, pool }) => {
      await registerTask(kernel, 'rt-task', [ns]);
      const src = await makeCanceledSource(kernel, 'rt-task', ns);

      const [a, b] = await Promise.all([
        kernel.retryRun(src, ns, { operationKey: 'k-1' }),
        kernel.retryRun(src, ns, { operationKey: 'k-1' }),
      ]);

      expect(a.runId).toBe(b.runId);

      const ops = await pool.query<{ retry_run_id: string }>(
        `SELECT retry_run_id FROM run_retry_operations WHERE source_run_id = $1`,
        [src],
      );
      expect(ops.rows).toHaveLength(1);
      expect(ops.rows[0].retry_run_id).toBe(a.runId);

      const runs = await pool.query(`SELECT count(*)::int AS n FROM runs WHERE trigger_type = 'retry'`);
      expect(runs.rows[0].n).toBe(1);
    });
  });

  it('a replayed key returns the original run id without executing again', async () => {
    await withPg('retry_replay', async ({ kernel, pool }) => {
      await registerTask(kernel, 'rt-task', [ns]);
      const src = await makeCanceledSource(kernel, 'rt-task', ns);

      const first = await kernel.retryRun(src, ns, { operationKey: 'k-replay' });
      // "Lost response" — the client re-sends the same request after a timeout.
      const replay = await kernel.retryRun(src, ns, { operationKey: 'k-replay' });

      expect(replay.runId).toBe(first.runId);

      // Nothing new was created: one operation row, one retry run, one queue row.
      const ops = await pool.query(`SELECT count(*)::int AS n FROM run_retry_operations`);
      expect(ops.rows[0].n).toBe(1);
      const runs = await pool.query(`SELECT count(*)::int AS n FROM runs WHERE trigger_type = 'retry'`);
      expect(runs.rows[0].n).toBe(1);
      const queue = await pool.query<{ run_id: string }>(`SELECT run_id FROM queue`);
      expect(queue.rows).toHaveLength(1);
      expect(queue.rows[0].run_id).toBe(first.runId);
    });
  });

  it('different keys are different operations; no key keeps the legacy fresh-retry semantics', async () => {
    await withPg('retry_distinct_ops', async ({ kernel, pool }) => {
      await registerTask(kernel, 'rt-task', [ns]);
      const src = await makeCanceledSource(kernel, 'rt-task', ns);

      const ka = await kernel.retryRun(src, ns, { operationKey: 'k-a' });
      const kb = await kernel.retryRun(src, ns, { operationKey: 'k-b' });
      expect(kb.runId).not.toBe(ka.runId);

      const noKey1 = await kernel.retryRun(src, ns);
      const noKey2 = await kernel.retryRun(src, ns);
      expect(noKey2.runId).not.toBe(noKey1.runId);

      // Four retry runs total; the no-key calls recorded nothing.
      const runs = await pool.query(`SELECT count(*)::int AS n FROM runs WHERE trigger_type = 'retry'`);
      expect(runs.rows[0].n).toBe(4);
      const ops = await pool.query(`SELECT count(*)::int AS n FROM run_retry_operations`);
      expect(ops.rows[0].n).toBe(2);
    });
  });

  it('the same key in different namespaces creates independent retries (C2)', async () => {
    await withPg('retry_ns_isolation', async ({ kernel, pool }) => {
      const acme = { projectId: 'acme', env: 'prod' };
      await registerTask(kernel, 'rt-task', [ns, acme]);
      const srcDefault = await makeCanceledSource(kernel, 'rt-task', ns);
      const srcAcme = await makeCanceledSource(kernel, 'rt-task', acme);

      const a = await kernel.retryRun(srcDefault, ns, { operationKey: 'k-shared' });
      const b = await kernel.retryRun(srcAcme, acme, { operationKey: 'k-shared' });
      expect(b.runId).not.toBe(a.runId);

      const ops = await pool.query<{ project_id: string }>(
        `SELECT project_id FROM run_retry_operations ORDER BY project_id`,
      );
      expect(ops.rows).toHaveLength(2);
      expect(ops.rows.map((r) => r.project_id)).toEqual(['acme', 'default']);
    });
  });

  it('defense-in-depth: a unique violation from an FK-bypassing writer resolves through the committed-row read-back', async () => {
    await withPg('retry_uc_defense', async ({ kernel, pool }) => {
      await registerTask(kernel, 'rt-task', [ns]);
      const src = await makeCanceledSource(kernel, 'rt-task', ns);

      // The 23505 branch is NOT the real same-key race — under normal FK
      // enforcement the operation row's FK check holds KEY SHARE on the
      // source run, so a same-key retry blocks at its source-row lock
      // (canonical position 2) and resolves through the committed-row replay
      // path once the first commits. This test forces the fallback: a foreign
      // transaction mints the WINNER's run + operation row but keeps them
      // uncommitted (invisible to the retry's SELECT), so the retry must
      // proceed to insert and lose the unique race once the winner commits.
      // `session_replication_role = replica` disables FK enforcement on this
      // connection — that is the only way an operation row can exist without
      // its writer having passed through the source-row lock.
      const ext = await pool.connect();
      try {
        await ext.query('BEGIN');
        await ext.query(`SET LOCAL session_replication_role = replica`);
        await ext.query(
          `INSERT INTO runs (id, project_id, env, task_id, status, trigger_type)
           VALUES ('run_ext', 'default', 'prod', 'rt-task', 'queued', 'retry')`,
        );
        await ext.query(
          `INSERT INTO run_retry_operations
             (project_id, env, source_run_id, operation_key, retry_run_id)
           VALUES ('default', 'prod', $1, 'k-race', 'run_ext')`,
          [src],
        );

        const pending = kernel.retryRun(src, ns, { operationKey: 'k-race' });
        // Wait until the retry is actually blocked on the winner's uncommitted
        // row before committing — committing "too early" would just make the
        // retry take the committed-row replay path instead of the 23505 one.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const blocked = await pool.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE query LIKE '%INSERT INTO run_retry_operations%'
                AND state = 'active' AND wait_event IS NOT NULL`,
          );
          if (blocked.rows[0].n > 0) break;
          if (Date.now() > deadline) throw new Error('retry never blocked on the foreign operation row');
          await sleep(20);
        }
        await ext.query('COMMIT');

        const res = await pending;
        expect(res.runId).toBe('run_ext');

        // The loser rolled its whole tx back: the winner's run is the ONLY
        // retry run and the ONLY operation row.
        const runs = await pool.query<{ id: string }>(`SELECT id FROM runs WHERE trigger_type = 'retry'`);
        expect(runs.rows).toHaveLength(1);
        expect(runs.rows[0].id).toBe('run_ext');
        const ops = await pool.query(`SELECT count(*)::int AS n FROM run_retry_operations`);
        expect(ops.rows[0].n).toBe(1);
      } finally {
        await ext.release();
      }
    });
  });

  it('only failed/canceled sources can be retried — everything else is a stable conflict', async () => {
    await withPg('retry_terminal_gate', async ({ kernel, pool }) => {
      await registerTask(kernel, 'rt-task', [ns]);
      const { runId } = await kernel.trigger({ taskId: 'rt-task', payload: {}, namespace: ns });

      // queued → conflict (never claimed, so no queue/claim setup needed)
      await expect(kernel.retryRun(runId, ns, { operationKey: 'k' })).rejects.toMatchObject({
        code: 'conflict',
      });
      await pool.query(`UPDATE runs SET status = 'running' WHERE id = $1`, [runId]);
      await expect(kernel.retryRun(runId, ns, { operationKey: 'k' })).rejects.toMatchObject({
        code: 'conflict',
      });
      await pool.query(`UPDATE runs SET status = 'completed', finished_at = now() WHERE id = $1`, [runId]);
      await expect(kernel.retryRun(runId, ns, { operationKey: 'k' })).rejects.toMatchObject({
        code: 'conflict',
      });

      // A missing source is not_found, and none of the refusals recorded anything.
      await expect(kernel.retryRun('run_missing', ns, { operationKey: 'k' })).rejects.toMatchObject({
        code: 'not_found',
      });
      const ops = await pool.query(`SELECT count(*)::int AS n FROM run_retry_operations`);
      expect(ops.rows[0].n).toBe(0);
      const retries = await pool.query(`SELECT count(*)::int AS n FROM runs WHERE trigger_type = 'retry'`);
      expect(retries.rows[0].n).toBe(0);
    });
  });
});
