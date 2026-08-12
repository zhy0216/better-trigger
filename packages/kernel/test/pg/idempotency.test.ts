import { expect, it } from 'vitest';
import { describePg, withPg } from './helpers';

describePg('idempotency', () => {
  const ns = { projectId: 'default', env: 'prod' };

  it('same key re-trigger returns the same run and enqueues nothing', async () => {
    await withPg('idem_same_key', async ({ kernel, pool }) => {
      await kernel.registerWorker({
        codeVersion: 'v1',
        runtime: 'test',
        concurrency: 1,
        namespaces: [ns],
        tasks: [{ id: 'idem-task', codeVersion: 'v1' }],
      });

      const first = await kernel.trigger({
        taskId: 'idem-task',
        payload: { n: 1 },
        namespace: ns,
        options: { idempotencyKey: 'k-1' },
      });
      const second = await kernel.trigger({
        taskId: 'idem-task',
        payload: { n: 2 },
        namespace: ns,
        options: { idempotencyKey: 'k-1' },
      });

      expect(second.runId).toBe(first.runId);
      expect(second.idempotent).toBe(true);

      const runs = await pool.query(`SELECT id, idempotency_key FROM runs`);
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0].id).toBe(first.runId);
      expect(runs.rows[0].idempotency_key).toBe('k-1');

      const queue = await pool.query<{ run_id: string }>(`SELECT run_id FROM queue`);
      expect(queue.rows).toHaveLength(1);
      expect(queue.rows[0].run_id).toBe(first.runId);
    });
  });

  it('different keys create different runs', async () => {
    await withPg('idem_diff_keys', async ({ kernel, pool }) => {
      await kernel.registerWorker({
        codeVersion: 'v1',
        runtime: 'test',
        concurrency: 1,
        namespaces: [ns],
        tasks: [{ id: 'idem-task', codeVersion: 'v1' }],
      });

      const a = await kernel.trigger({
        taskId: 'idem-task',
        payload: { n: 1 },
        namespace: ns,
        options: { idempotencyKey: 'k-a' },
      });
      const b = await kernel.trigger({
        taskId: 'idem-task',
        payload: { n: 2 },
        namespace: ns,
        options: { idempotencyKey: 'k-b' },
      });

      expect(a.idempotent).toBe(false);
      expect(b.idempotent).toBe(false);
      expect(b.runId).not.toBe(a.runId);

      const runs = await pool.query(`SELECT count(*)::int AS n FROM runs`);
      expect(runs.rows[0].n).toBe(2);
      const queue = await pool.query(`SELECT count(*)::int AS n FROM queue`);
      expect(queue.rows[0].n).toBe(2);
    });
  });

  it('the same key in a different namespace creates an independent run (C2)', async () => {
    await withPg('idem_namespaces', async ({ kernel, pool }) => {
      const acme = { projectId: 'acme', env: 'prod' };
      await kernel.registerWorker({
        codeVersion: 'v1',
        runtime: 'test',
        concurrency: 1,
        namespaces: [ns, acme],
        tasks: [{ id: 'idem-task', codeVersion: 'v1' }],
      });

      const a = await kernel.trigger({
        taskId: 'idem-task',
        payload: { n: 1 },
        namespace: ns,
        options: { idempotencyKey: 'k-shared' },
      });
      const b = await kernel.trigger({
        taskId: 'idem-task',
        payload: { n: 1 },
        namespace: acme,
        options: { idempotencyKey: 'k-shared' },
      });

      expect(a.idempotent).toBe(false);
      expect(b.idempotent).toBe(false);
      expect(b.runId).not.toBe(a.runId);

      const runs = await pool.query<{ id: string; project_id: string }>(
        `SELECT id, project_id FROM runs ORDER BY project_id`,
      );
      expect(runs.rows).toHaveLength(2);
      expect(runs.rows.map((r) => r.id).sort()).toEqual([a.runId, b.runId].sort());
      expect(runs.rows.map((r) => r.project_id).sort()).toEqual(['acme', 'default']);

      const queue = await pool.query(`SELECT count(*)::int AS n FROM queue`);
      expect(queue.rows[0].n).toBe(2);
    });
  });

  it('single-run and batch idempotency paths share the same key space', async () => {
    await withPg('idem_single_vs_batch', async ({ kernel, pool }) => {
      await kernel.registerWorker({
        codeVersion: 'v1',
        runtime: 'test',
        concurrency: 1,
        namespaces: [ns],
        tasks: [{ id: 'idem-task', codeVersion: 'v1' }],
      });

      const single = await kernel.trigger({
        taskId: 'idem-task',
        payload: { n: 1 },
        namespace: ns,
        options: { idempotencyKey: 'k-shared' },
      });

      const batch = await kernel.batchTrigger(
        [{ taskId: 'idem-task', payload: { n: 2 }, options: { idempotencyKey: 'k-shared' } }],
        ns,
      );

      expect(batch.runIds).toHaveLength(1);
      expect(batch.runIds[0]).toBe(single.runId);

      const runs = await pool.query(`SELECT count(*)::int AS n FROM runs`);
      expect(runs.rows[0].n).toBe(1);
      const queue = await pool.query(`SELECT count(*)::int AS n FROM queue`);
      expect(queue.rows[0].n).toBe(1);
    });
  });
});
