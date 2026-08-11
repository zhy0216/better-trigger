/* =============================================================================
   @better-trigger/worker — trigger routes resolve the namespace at the host
   boundary (C2).

   The kernel never infers a namespace: POST /trigger takes it from the body's
   options (projectId/env, default 'default'/'prod') and /batch-trigger from
   its top-level options, and an invalid pair is a 400 before the kernel sees
   it. The runs routes (cancel / retry / record / result) take it from
   ?projectId=&env= query params. Driven through createApp with a recording
   kernel mock (no Postgres).
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

function makeApp() {
  const calls: unknown[] = [];
  const kernel = {
    trigger: async (args: unknown) => {
      calls.push(args);
      return { runId: 'run_1', idempotent: false };
    },
    batchTrigger: async (_items: unknown, namespace: unknown) => {
      calls.push(namespace);
      return { runIds: ['run_1', 'run_2'] };
    },
    cancelRun: async (_id: string, namespace: unknown) => {
      calls.push(namespace);
    },
    retryRun: async (_id: string, namespace: unknown) => {
      calls.push(namespace);
      return { runId: 'run_9' };
    },
    getRun: async (_id: string, namespace: unknown) => {
      calls.push(namespace);
      return {};
    },
    waitForResult: async (_id: string, namespace: unknown) => {
      calls.push(namespace);
      return { status: 'completed' };
    },
  } as unknown as Kernel;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return { app: createApp({ kernel, pool }), calls };
}

const post = (path: string, body: unknown, query = '') =>
  new Request(`http://localhost:4848/api/v1${path}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = (path: string, query = '') =>
  new Request(`http://localhost:4848/api/v1${path}${query}`);

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_API_KEY;
  return () => {
    if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
    else process.env.BETTER_TRIGGER_API_KEY = savedKey;
  };
});

describe('POST /trigger', () => {
  it('defaults to default/prod when options say nothing', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(post('/trigger', { taskId: 't', payload: {} }));
    expect(res.status).toBe(200);
    expect((calls[0] as { namespace: unknown }).namespace).toEqual({
      projectId: 'default',
      env: 'prod',
    });
  });

  it('passes options.env + options.projectId through as the namespace', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(
      post('/trigger', {
        taskId: 't',
        payload: { n: 1 },
        options: { env: 'staging', projectId: 'acme', idempotencyKey: 'k1' },
      }),
    );
    expect(res.status).toBe(200);
    expect((calls[0] as { namespace: unknown }).namespace).toEqual({
      projectId: 'acme',
      env: 'staging',
    });
  });

  it('rejects an invalid namespace pair with 400 bad_request', async () => {
    const { app, calls } = makeApp();
    for (const options of [
      { env: '', projectId: 'acme' },
      { env: 'a:b', projectId: 'acme' },
      { env: 'staging', projectId: '' },
      { env: 'staging', projectId: 'x'.repeat(65) },
    ]) {
      const res = await app.fetch(post('/trigger', { taskId: 't', payload: {}, options }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'bad_request',
      );
    }
    expect(calls).toHaveLength(0); // nothing reached the kernel
  });
});

describe('POST /batch-trigger', () => {
  it('resolves the batch namespace from top-level options, default default/prod', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(
      post('/batch-trigger', {
        items: [{ taskId: 't', payload: {} }],
        options: { env: 'dev', projectId: 'acme' },
      }),
    );
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual({ projectId: 'acme', env: 'dev' });

    const bare = await app.fetch(post('/batch-trigger', { items: [{ taskId: 't', payload: {} }] }));
    expect(bare.status).toBe(200);
    expect(calls[1]).toEqual({ projectId: 'default', env: 'prod' });
  });
});

describe('runs routes take ?projectId=&env=', () => {
  it('scopes cancel/retry/record/result to the query namespace, default default/prod', async () => {
    const { app, calls } = makeApp();
    const NS = { projectId: 'acme', env: 'staging' };

    await app.fetch(post('/runs/run_1/cancel', {}, '?projectId=acme&env=staging'));
    expect(calls[0]).toEqual(NS);

    await app.fetch(post('/runs/run_1/retry', {}, '?projectId=acme&env=staging'));
    expect(calls[1]).toEqual(NS);

    await app.fetch(get('/runs/run_1/record', '?projectId=acme&env=staging'));
    expect(calls[2]).toEqual(NS);

    await app.fetch(get('/runs/run_1/result', '?projectId=acme&env=staging&timeoutMs=100'));
    expect(calls[3]).toEqual(NS);

    await app.fetch(post('/runs/run_2/cancel', {}));
    expect(calls[4]).toEqual({ projectId: 'default', env: 'prod' });
  });

  it('rejects an invalid query namespace with 400 before the kernel is called', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(post('/runs/run_1/cancel', {}, '?env=a:b'));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
