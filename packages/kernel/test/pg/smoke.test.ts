import { expect, it } from 'vitest';
import { describePg, withPg } from './helpers';

describePg('infra smoke', () => {
  it('provisions a database and drives the kernel', async () => {
    await withPg('smoke', async ({ kernel, pool }) => {
      await kernel.registerWorker({
        codeVersion: 'v1',
        runtime: 'test',
        concurrency: 1,
        namespaces: [{ projectId: 'default', env: 'prod' }],
        tasks: [{ id: 'smoke-task', codeVersion: 'v1' }],
      });
      const created = await kernel.trigger({
        taskId: 'smoke-task',
        payload: { n: 1 },
        namespace: { projectId: 'default', env: 'prod' },
      });
      const row = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [
        created.runId,
      ]);
      expect(row.rows[0]?.status).toBe('queued');
    });
  });
});
