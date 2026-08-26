/* =============================================================================
   @better-trigger/worker/embedded — host-mode tests.

   The durable SQL itself is covered by kernel PG / acceptance suites. These
   tests pin the new boundary without a database: startup owns the right
   resources, the normal BetterTrigger client crosses the in-process Hono
   adapter, TaskHandle defaults work, and shutdown restores process globals.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { createOrchestratorCounters } from '@better-trigger/kernel';
import { task, type BetterTrigger } from 'better-trigger';
import {
  getDefaultInstance,
  getResultResolver,
  setDefaultInstance,
  setResultResolver,
} from 'better-trigger/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  createPool: vi.fn(),
  migrate: vi.fn(),
  createKernel: vi.fn(),
}));

vi.mock('@better-trigger/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@better-trigger/db')>();
  return {
    ...actual,
    createPool: (...args: unknown[]) => mocked.createPool(...args),
    migrate: (...args: unknown[]) => mocked.migrate(...args),
  };
});

vi.mock('@better-trigger/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@better-trigger/kernel')>();
  return {
    ...actual,
    createKernel: (...args: unknown[]) => mocked.createKernel(...args),
  };
});

import {
  createEmbeddedRuntime,
  type EmbeddedRuntime,
} from '../src/embedded';

type FakePool = Pool;

function fakePool(): FakePool {
  return {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT status, output, error FROM runs')) {
        return {
          rows: [{ status: 'completed', output: { delivered: true }, error: null }],
        };
      }
      return { rows: [] };
    }),
    end: vi.fn(async () => {}),
  } as unknown as FakePool;
}

function fakeKernel(overrides: Partial<Kernel> = {}): Kernel {
  const orchestratorCounters = createOrchestratorCounters();
  return {
    trigger: vi.fn(async () => ({ runId: 'run_embedded', idempotent: false })),
    batchTrigger: vi.fn(async () => ({ runIds: ['run_batch_1'] })),
    cancelRun: vi.fn(async () => {}),
    retryRun: vi.fn(async () => ({ runId: 'run_retry' })),
    getRun: vi.fn(async () => ({ id: 'run_embedded', status: 'completed' }) as never),
    getRunDetail: vi.fn(async () => ({ run: { id: 'run_embedded' } }) as never),
    waitForResult: vi.fn(async () => ({ status: 'completed', output: { delivered: true } })),
    registerWorker: vi.fn(async () => ({ workerId: 'wkr_embedded' })),
    deregisterWorker: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => ({ cancelRunIds: [], lostRunIds: [] })),
    releaseClaims: vi.fn(async () => ({ releasedRunIds: [] })),
    claimRuns: vi.fn(async () => []),
    reportStep: vi.fn(async () => {}),
    suspendRun: vi.fn(async () => ({ resumed: false })),
    waitForChildRun: vi.fn(async () => ({ childRunId: 'run_child' })),
    batchTriggerChild: vi.fn(async () => ({ runIds: [] })),
    completeRun: vi.fn(async () => {}),
    failRun: vi.fn(async () => ({ willRetry: false })),
    appendLogs: vi.fn(async () => {}),
    startOrchestrator: vi.fn(() => ({
      stop: vi.fn(),
      counters: orchestratorCounters,
    })),
    prune: vi.fn(async () => ({}) as never),
    ...overrides,
  } as Kernel;
}

const sendEmail = task('send-email', async (_payload: { to: string }) => ({ delivered: true }));

let runtime: EmbeddedRuntime | null;
let pool: FakePool;
let kernel: Kernel;

const RATE_ENVS = [
  'BETTER_TRIGGER_RATE_LIMIT_RPS',
  'BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS',
  'BETTER_TRIGGER_RATE_LIMIT_BURST',
] as const;
const savedRateEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  runtime = null;
  pool = fakePool();
  kernel = fakeKernel();
  mocked.createPool.mockReset();
  mocked.createPool.mockReturnValue(pool);
  mocked.migrate.mockReset();
  mocked.migrate.mockResolvedValue(undefined);
  mocked.createKernel.mockReset();
  mocked.createKernel.mockReturnValue(kernel);
  setDefaultInstance(null);
  setResultResolver(null);
  delete process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_API_KEYS;
  for (const k of RATE_ENVS) {
    savedRateEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await runtime?.stop().catch(() => {});
  runtime = null;
  setDefaultInstance(null);
  setResultResolver(null);
  for (const k of RATE_ENVS) {
    if (savedRateEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedRateEnv[k];
  }
});

describe('createEmbeddedRuntime', () => {
  it('triggers and waits through the normal client without opening a server', async () => {
    runtime = await createEmbeddedRuntime({
      databaseUrl: 'postgres://embedded.test/db',
      tasks: [sendEmail],
      concurrency: 1,
      notifications: false,
    });

    const handle = await runtime.client.trigger(sendEmail, { to: 'a@example.com' });
    expect(handle.id).toBe('run_embedded');
    await expect(handle.result()).resolves.toEqual({
      status: 'completed',
      output: { delivered: true },
      error: undefined,
    });
    expect(kernel.trigger).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'send-email' }));
    expect(runtime.client.url).toBe('http://better-trigger.internal');
    expect(mocked.migrate).toHaveBeenCalledWith(pool);
  });

  it('installs in-run result resolution before the worker can claim backlog', async () => {
    kernel = fakeKernel({
      registerWorker: vi.fn(async () => {
        expect(getResultResolver()).not.toBeNull();
        return { workerId: 'wkr_embedded' };
      }),
    });
    mocked.createKernel.mockReturnValue(kernel);

    runtime = await createEmbeddedRuntime({
      databaseUrl: 'postgres://embedded.test/db',
      tasks: [sendEmail],
      concurrency: 1,
      notifications: false,
    });

    expect(kernel.registerWorker).toHaveBeenCalledOnce();
  });

  it('installs TaskHandle defaults and restores the previous client on stop', async () => {
    const previousFetch = vi.fn(async () =>
      Response.json({ runId: 'run_previous', idempotent: false }),
    );
    const previous: BetterTrigger = (await import('better-trigger')).betterTrigger({
      url: 'http://previous.test',
      fetch: previousFetch,
    });
    previous.setDefault();

    runtime = await createEmbeddedRuntime({
      databaseUrl: 'postgres://embedded.test/db',
      tasks: [sendEmail],
      concurrency: 1,
      notifications: false,
    });
    expect(getDefaultInstance()).toBe(runtime.client);
    expect((await sendEmail.trigger({ to: 'embedded@example.com' })).id).toBe('run_embedded');

    await runtime.stop();
    runtime = null;
    expect(getDefaultInstance()).toBe(previous);
    expect((await sendEmail.trigger({ to: 'previous@example.com' })).id).toBe('run_previous');
  });

  it('does not claim an injected pool unless explicitly asked', async () => {
    runtime = await createEmbeddedRuntime({
      pool,
      tasks: [sendEmail],
      concurrency: 1,
      migrate: false,
      notifications: false,
      setDefault: false,
    });

    expect(mocked.createPool).not.toHaveBeenCalled();
    expect(mocked.migrate).not.toHaveBeenCalled();
    expect(getDefaultInstance()).toBeNull();
    expect((await runtime.client.trigger(sendEmail, { to: 'a@example.com' })).id).toBe(
      'run_embedded',
    );

    await runtime.stop();
    runtime = null;
    expect(pool.end).not.toHaveBeenCalled();
    expect(getResultResolver()).toBeNull();
  });

  it('rejects a second active runtime and releases the slot after stop', async () => {
    runtime = await createEmbeddedRuntime({
      databaseUrl: 'postgres://embedded.test/db',
      tasks: [sendEmail],
      concurrency: 1,
      notifications: false,
    });

    await expect(
      createEmbeddedRuntime({
        databaseUrl: 'postgres://embedded.test/other',
        tasks: [sendEmail],
        concurrency: 1,
        notifications: false,
      }),
    ).rejects.toThrow('only one createEmbeddedRuntime instance');

    await runtime.stop();
    runtime = await createEmbeddedRuntime({
      databaseUrl: 'postgres://embedded.test/restarted',
      tasks: [sendEmail],
      concurrency: 1,
      notifications: false,
    });
    expect(runtime.worker.workerId).toBe('wkr_embedded');
  });

  it('closes an owned pool and releases the process slot when startup fails', async () => {
    kernel = fakeKernel({
      registerWorker: vi.fn(async () => {
        throw new Error('registration failed');
      }),
    });
    mocked.createKernel.mockReturnValueOnce(kernel);

    await expect(
      createEmbeddedRuntime({
        databaseUrl: 'postgres://embedded.test/db',
        tasks: [sendEmail],
        concurrency: 1,
        notifications: false,
      }),
    ).rejects.toThrow('registration failed');
    expect(pool.end).toHaveBeenCalledOnce();

    // The failed startup must not poison the process-wide single-runtime slot.
    mocked.createKernel.mockReturnValue(fakeKernel());
    const nextPool = fakePool();
    mocked.createPool.mockReturnValue(nextPool);
    runtime = await createEmbeddedRuntime({
      databaseUrl: 'postgres://embedded.test/retry',
      tasks: [sendEmail],
      concurrency: 1,
      notifications: false,
    });
    expect(runtime.pool).toBe(nextPool);
  });

  it('does not rate-limit its own in-process client even far past the default burst', async () => {
    // Defaults: anon write bucket is 50 rps / burst 200. Without the
    // internal-request exemption, the 200+ concurrent triggers past the burst
    // would draw the shared anon bucket and answer 429 (P1-03).
    runtime = await createEmbeddedRuntime({
      databaseUrl: 'postgres://embedded.test/db',
      tasks: [sendEmail],
      concurrency: 1,
      notifications: false,
    });

    const handles = await Promise.all(
      Array.from({ length: 250 }, () =>
        runtime!.client.trigger(sendEmail, { to: 'bulk@example.com' }),
      ),
    );
    expect(handles.every((h) => h.id === 'run_embedded')).toBe(true);
  });

  it('still rate-limits an unmarked host-mounted fetch on the same app', async () => {
    // The embedded `app` may be mounted externally; that surface must stay
    // limited. An unmarked Request (never passed through the in-process fetch
    // adapter) still draws the write bucket and 429s past the burst.
    process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = '1';
    process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '0';
    process.env.BETTER_TRIGGER_RATE_LIMIT_BURST = '1';
    runtime = await createEmbeddedRuntime({
      databaseUrl: 'postgres://embedded.test/db',
      tasks: [sendEmail],
      concurrency: 1,
      notifications: false,
    });

    const unmarked = () =>
      new Request('http://better-trigger.internal/api/v1/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'send-email', payload: { to: 'a@example.com' } }),
      });

    expect((await runtime!.app.fetch(unmarked())).status).toBe(200);
    expect((await runtime!.app.fetch(unmarked())).status).toBe(429);
  });
});
