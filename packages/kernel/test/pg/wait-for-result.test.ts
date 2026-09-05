import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { DEFAULT_NAMESPACE as NS, ResultTimeoutError } from '@better-trigger/core';
import { createKernel } from '../../src';
import { describePg, withPg } from './helpers';

describePg('waitForResult contract', () => {
  it('shares timeout identity and preserves zero-budget and terminal reads', async () => {
    await withPg('wait_result', async ({ kernel }) => {
      await kernel.registerWorker({
        codeVersion: 'v1', runtime: 'test', concurrency: 1, namespaces: [NS],
        tasks: [{ id: 'wait-result', codeVersion: 'v1' }],
      });
      const { runId } = await kernel.trigger({ taskId: 'wait-result', payload: {}, namespace: NS });
      await expect(kernel.waitForResult(runId, NS, { timeoutMs: 0, throwOnTimeout: true }))
        .resolves.toEqual({ status: 'queued' });
      const started = Date.now();
      const error = await kernel.waitForResult(runId, NS, {
        timeoutMs: 50, pollMs: 250, throwOnTimeout: true,
      }).catch((err: unknown) => err);
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
      expect(error).toBeInstanceOf(ResultTimeoutError);
      expect(error).toMatchObject({ status: 'queued' });
      await kernel.cancelRun(runId, NS);
      await expect(kernel.waitForResult(runId, NS, { timeoutMs: Infinity }))
        .resolves.toEqual({ status: 'canceled', output: undefined, error: undefined });
    });
  });

  it.each(['success', 'statement timeout'])('aborts a locked SQL read before its late %s', async (outcome) => {
    await withPg('wait_abort', async ({ pool, db }) => {
      const reader = new Pool({ connectionString: db.url, max: 1, statement_timeout: 1_500 });
      const query = vi.spyOn(reader, 'query');
      const released = vi.fn();
      reader.on('release', released);
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('LOCK TABLE runs IN ACCESS EXCLUSIVE MODE');
        const controller = new AbortController();
        const kernel = createKernel({ pool: reader });
        const pending = kernel.waitForResult('run_blocked', NS, {
          signal: controller.signal, timeoutMs: Infinity,
        }).catch((error: unknown) => error);
        const blocked = async () => {
          const result = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND state = 'active'
               AND wait_event_type = 'Lock' AND query LIKE 'SELECT status, output, error FROM runs%'`,
          );
          return result.rows[0].n;
        };
        await expect.poll(blocked, { timeout: 1_000 }).toBe(1);
        const reason = new Error('request disconnected');
        controller.abort(reason);
        let result: unknown;
        void pending.then((error) => { result = error; });
        await expect.poll(() => result, { timeout: 500 }).toBe(reason);
        // Aborting the caller did not cancel PostgreSQL: SQL is still locked.
        expect(await blocked()).toBe(1);
        if (outcome === 'success') await locker.query('ROLLBACK');
        // A statement timeout bounds the outstanding SQL if the lock stays held.
        await expect.poll(() => reader.totalCount - reader.idleCount, { timeout: 3_000 }).toBe(0);
        expect(released).toHaveBeenCalledTimes(1);
        if (outcome === 'statement timeout') {
          expect(released.mock.calls[0]![0]).toMatchObject({ code: '57014' });
        }
        expect(query).toHaveBeenCalledTimes(1);
        expect(await pending).toBe(reason);
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
        query.mockRestore();
        await reader.end();
      }
    });
  });
});
