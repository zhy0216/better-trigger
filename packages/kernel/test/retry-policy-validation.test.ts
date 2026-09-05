/* =============================================================================
   @better-trigger/kernel — RetryPolicy range validation at the two boundaries
   (todos/p1-16-config-input-validation.md C1).

   - registration: registerWorker is the ONLY path a policy takes into
     tasks.retry (subtask triggers never pass through HTTP), so it must refuse
     a garbage manifest BEFORE the transaction opens — the sentinel pool below
     proves nothing connected;
   - trigger: a garbage policy that predates the guard (a row written by an
     old worker) must surface as bad_request 400 at createRunIn — the
     resolveRetryPolicy call that feeds max_attempts into the runs row —
     instead of a NaN attempt budget exploding on the first failed run.

   The registration block also pins the sibling boundary guard: registerWorker
   validates `concurrency` before the tx opens (the workers.concurrency column
   carries no CHECK, so a garbage value would otherwise land in the row or
   surface as a bare driver error).

   Stub clients verify rejection before writes; a gated Postgres case checks
   the integer boundary and retry scheduling against real storage.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError, type RetryPolicy } from '@better-trigger/core';
import { registerWorker } from '../src/workers';
import { createRunIn, failRun } from '../src/runs';
import { describePg, withPg } from './pg/helpers';

const expectBadRequest = async (promise: Promise<unknown>, message: string) => {
  await expect(promise).rejects.toBeInstanceOf(KernelError);
  await promise.catch((err: KernelError) => {
    expect(err.code).toBe('bad_request');
    expect(err.message).toContain(message);
  });
};

describe('registerWorker retry validation', () => {
  /** Any use of this pool fails the test loudly — validation must throw first. */
  const sentinel = new Error('connect() reached — validation did not refuse');
  const refusingPool = {
    connect: async () => {
      throw sentinel;
    },
  } as unknown as Pool;

  const register = (retry: RetryPolicy | undefined) =>
    registerWorker(refusingPool, {
      codeVersion: 'v1',
      runtime: 'test',
      concurrency: 1,
      namespaces: [DEFAULT_NAMESPACE],
      tasks: [{ id: 't', ...(retry === undefined ? {} : { retry }) }],
    });

  it('refuses NaN / 0 / negative maxAttempts and a negative factor before connecting', async () => {
    await expectBadRequest(register({ maxAttempts: NaN }), 'task "t".retry.maxAttempts');
    await expectBadRequest(register({ maxAttempts: 0 }), 'task "t".retry.maxAttempts');
    await expectBadRequest(register({ maxAttempts: -3 }), 'task "t".retry.maxAttempts');
    await expectBadRequest(register({ maxAttempts: 2_147_483_648 }), 'task "t".retry.maxAttempts');
    await expectBadRequest(register({ factor: -2 }), 'task "t".retry.factor');
    await expectBadRequest(register({ baseMs: -5 }), 'task "t".retry.baseMs');
    await expectBadRequest(register({ maxMs: -5 }), 'task "t".retry.maxMs');
  });

  it('accepts absent and in-range policies (the stub proves nothing else broke)', async () => {
    // A valid registration reaches connect() — the sentinel, not a KernelError.
    await expect(register(undefined)).rejects.toBe(sentinel);
    await expect(register({ maxAttempts: 2_147_483_647 })).rejects.toBe(sentinel);
    await expect(register({ maxAttempts: 1, factor: 1.5, baseMs: 0, maxMs: 0 })).rejects.toBe(
      sentinel,
    );
  });
});

describe('createRunIn trigger-path retry validation', () => {
  /** Answers the tasks lookup with a stored retry and records statements. */
  const makeClient = (taskRetry: RetryPolicy | null) => {
    const sqls: string[] = [];
    const client = {
      query: async (sql: string) => {
        sqls.push(sql);
        // The database-clock read (T1).
        if (/^SELECT now\(\)/.test(sql)) return { rows: [{ now: new Date() }] };
        return {
          rows: [{ id: 't', retry: taskRetry, concurrency_limit: null, latest_code_version: null }],
        };
      },
    } as unknown as PoolClient;
    return { client, sqls };
  };

  const trigger = (taskRetry: RetryPolicy | null, argsRetry?: RetryPolicy) => {
    const { client, sqls } = makeClient(taskRetry);
    const run = createRunIn(client, {
      taskId: 't',
      payload: null,
      triggerType: 'api',
      namespace: DEFAULT_NAMESPACE,
      requireTask: true,
      ...(argsRetry === undefined ? {} : { retry: argsRetry }),
    });
    return { run, sqls };
  };

  it('refuses a garbage stored task.retry instead of stamping the run with it', async () => {
    for (const [retry, field] of [
      [{ maxAttempts: NaN }, 'maxAttempts'],
      [{ maxAttempts: 0 }, 'maxAttempts'],
      [{ maxAttempts: 2_147_483_648 }, 'maxAttempts'],
      [{ factor: -2 }, 'factor'],
      [{ maxMs: -5 }, 'maxMs'],
    ] as Array<[RetryPolicy, string]>) {
      const { run, sqls } = trigger(retry);
      await expect(run).rejects.toBeInstanceOf(KernelError);
      await run.catch((err: KernelError) => {
        expect(err.code).toBe('bad_request');
        expect(err.message).toContain(`retry.${field}`);
      });
      expect(sqls.some((s) => /INSERT/.test(s))).toBe(false);
    }
  });

  it('refuses a garbage per-trigger retry option, naming the field', async () => {
    for (const [retry, field] of [
      [{ maxAttempts: NaN }, 'maxAttempts'],
      [{ maxAttempts: 0 }, 'maxAttempts'],
      [{ maxAttempts: 2_147_483_648 }, 'maxAttempts'],
      [{ factor: -2 }, 'factor'],
    ] as Array<[RetryPolicy, string]>) {
      const { run, sqls } = trigger(null, retry);
      await expect(run).rejects.toBeInstanceOf(KernelError);
      await run.catch((err: KernelError) => {
        expect(err.code).toBe('bad_request');
        expect(err.message).toContain(`retry.${field}`);
      });
      expect(sqls.some((s) => /INSERT/.test(s))).toBe(false);
    }
  });

  it('still triggers with valid stored / option policies', async () => {
    const stored = trigger({ maxAttempts: 5, factor: 2 });
    await stored.run.catch(() => {});
    expect(stored.sqls.some((s) => /INSERT INTO runs/.test(s))).toBe(true);

    const option = trigger({ maxAttempts: NaN }, { maxAttempts: 2 });
    await option.run.catch(() => {});
    expect(option.sqls.some((s) => /INSERT INTO runs/.test(s))).toBe(true);
  });
});

describe('failRun retry timestamp validation', () => {
  const retryAt = (retry: RetryPolicy, clock: Date) => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        if (/^SELECT now\(\)/.test(sql)) return { rows: [{ now: clock }] };
        if (/FROM queue WHERE run_id/.test(sql)) {
          return { rows: [{ run_id: 'r', locked_by: 'w' }] };
        }
        if (/FROM runs WHERE id/.test(sql)) {
          return {
            rows: [{ id: 'r', status: 'running', attempt: 1025, max_attempts: 2_147_483_647, fencing_token: '1' }],
          };
        }
        return { rows: [] };
      },
      release: () => {},
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const result = failRun(pool, {
      runId: 'r',
      error: { message: 'retry me' },
      workerId: 'w',
      fencingToken: 1,
      namespace: DEFAULT_NAMESPACE,
      retry,
    });
    return { result, statements };
  };

  it.each([
    ['large finite backoff', { baseMs: 2e16, maxMs: 2e16, factor: 1 }, new Date(0)],
    ['Date addition overflow', { baseMs: 10, factor: 1 }, new Date(8.64e15)],
    ['invalid database clock', { baseMs: 0 }, new Date(NaN)],
  ] as const)('rejects %s before writing a retry', async (_label, policy, clock) => {
    const { result, statements } = retryAt(policy, clock);
    await expectBadRequest(result, 'duration');
    expect(statements.some(({ sql }) => /^\s*(UPDATE|INSERT)\b/.test(sql))).toBe(false);
    expect(statements.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
  });

  it('writes a valid zero-delay retry at the upper Date boundary', async () => {
    const clock = new Date(8.64e15);
    const { result, statements } = retryAt({ baseMs: 0, factor: 2 }, clock);
    await expect(result).resolves.toEqual({ willRetry: true, nextAttemptAt: clock.toISOString() });
    const availableAt = statements.find(({ sql }) => /UPDATE queue/.test(sql))?.params[1];
    expect(availableAt).toEqual(clock);
    expect(availableAt).not.toBe(clock);
    expect(clock.getTime()).toBe(8.64e15);
  });
});

describePg('retry numeric boundaries in PostgreSQL', () => {
  it('stores the integer limit, rejects an unrepresentable retry, and schedules zero backoff', async () => {
    await withPg('retry_numeric_boundaries', async ({ kernel, pool }) => {
      const { workerId } = await kernel.registerWorker({
        codeVersion: 'v1',
        runtime: 'test',
        concurrency: 1,
        namespaces: [DEFAULT_NAMESPACE],
        tasks: [{ id: 'numeric', retry: { maxAttempts: 2_147_483_647 } }],
      });
      const { runId } = await kernel.trigger({
        taskId: 'numeric', payload: null, namespace: DEFAULT_NAMESPACE,
      });
      await pool.query('UPDATE runs SET attempt = 1025 WHERE id = $1', [runId]);
      const claimed = await kernel.claimRuns({
        workerId,
        namespaces: [DEFAULT_NAMESPACE],
        taskIds: ['numeric'],
        limit: 1,
        leaseMs: 60_000,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.maxAttempts).toBe(2_147_483_647);
      const args = {
        runId, workerId, fencingToken: claimed[0]!.fencingToken,
        namespace: DEFAULT_NAMESPACE, error: { message: 'retry me' },
      };
      await expectBadRequest(kernel.failRun({
        ...args, retry: { baseMs: 2e16, maxMs: 2e16, factor: 1 },
      }), 'out of range');
      const unchanged = await pool.query('SELECT status, attempt FROM runs WHERE id = $1', [runId]);
      expect(unchanged.rows).toEqual([{ status: 'running', attempt: 1025 }]);

      const result = await kernel.failRun({ ...args, retry: { baseMs: 0, factor: 2 } });
      expect(result.willRetry).toBe(true);
      expect(Number.isFinite(new Date(result.nextAttemptAt!).getTime())).toBe(true);
      const retried = await pool.query(
        `SELECT r.status, r.attempt, q.available_at, q.available_at <= now() AS due
           FROM runs r JOIN queue q ON q.run_id = r.id WHERE r.id = $1`, [runId],
      );
      expect(retried.rows[0]).toMatchObject({ status: 'queued', attempt: 1026, due: true });
      expect(retried.rows[0].available_at.toISOString()).toBe(result.nextAttemptAt);
    });
  });
});

describe('registerWorker concurrency validation', () => {
  const sentinel = new Error('connect() reached — concurrency guard did not refuse');
  const refusingPool = {
    connect: async () => {
      throw sentinel;
    },
  } as unknown as Pool;

  const register = (concurrency: number) =>
    registerWorker(refusingPool, {
      codeVersion: 'v1',
      runtime: 'test',
      concurrency,
      namespaces: [DEFAULT_NAMESPACE],
      tasks: [{ id: 't' }],
    });

  it('refuses 0 / negative / fractional / NaN concurrency before connecting', async () => {
    for (const concurrency of [0, -1, 2.5, NaN]) {
      await expect(register(concurrency)).rejects.toBeInstanceOf(KernelError);
      await register(concurrency).catch((err: KernelError) => {
        expect(err.code).toBe('bad_request');
        expect(err.message).toMatch(/concurrency must be a positive integer/);
      });
    }
  });

  it('accepts a positive integer (the sentinel proves only concurrency was checked)', async () => {
    await expect(register(4)).rejects.toBe(sentinel);
  });
});
