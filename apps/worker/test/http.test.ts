/* =============================================================================
   @better-trigger/worker — body/query validation + status mapping tests.

   A body the client got wrong must be reported as the client's error: every
   body-reading route goes through safeJson, so malformed / empty / non-object
   JSON is a 400 bad_request, never a 500 internal_error — and it must not log
   an "unhandled error" either, since that line means "the server is broken".
   The same holds one level down for the fields read off a body or query string:
   a wrong-typed `enabled` or a negative `limit` must be rejected before pg sees
   it (where it would become a NOT NULL violation / "LIMIT must not be
   negative" → 500).
   Routes are driven through createApp with stub deps (no Postgres involved).
   ============================================================================= */
import type { Pool } from 'pg';
import { createKernel, type Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { WaiterRegistry } from '../src/waiters';

/** Records what the routes reached, so we can assert nothing did on a 400. */
interface Calls {
  trigger: unknown[];
  batchTrigger: unknown[];
  query: { sql: string; params: unknown[] }[];
  waitForResult: unknown[];
}

const makeApp = (waiters?: WaiterRegistry) => {
  const calls: Calls = { trigger: [], batchTrigger: [], query: [], waitForResult: [] };
  const kernel = {
    trigger: async (input: unknown) => {
      calls.trigger.push(input);
      return { runId: 'run_1', idempotent: false };
    },
    batchTrigger: async (items: unknown) => {
      calls.batchTrigger.push(items);
      return { runIds: ['run_1'] };
    },
    waitForResult: async (...args: unknown[]) => {
      calls.waitForResult.push(args);
      return { status: 'completed', output: 'ok' };
    },
  } as unknown as Kernel;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.query.push({ sql, params });
      // Only the schedules lookup needs a row (so PATCH gets past its 404).
      return /FROM schedules/.test(sql)
        ? { rows: [{ cron_pattern: '0 * * * *', cron_tz: null }] }
        : { rows: [] };
    },
  } as unknown as Pool;
  return { app: createApp(waiters ? { kernel, pool, waiters } : { kernel, pool }), calls };
};

const send = (method: string, path: string, body?: string) =>
  new Request(`http://localhost/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  });
const post = (path: string, body: string) => send('POST', path, body);
const patch = (path: string, body: string) => send('PATCH', path, body);
const get = (path: string) => new Request(`http://localhost/api/v1${path}`);

let errorSpy: ReturnType<typeof vi.spyOn>;
let savedKey: string | undefined;

beforeEach(() => {
  // authMiddleware is a no-op only while the env key is unset.
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_API_KEY;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
  else process.env.BETTER_TRIGGER_API_KEY = savedKey;
});

describe('body parsing', () => {
  it('rejects malformed JSON with 400 bad_request and no error log', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(post('/trigger', '{"taskId":'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'bad_request', message: 'request body must be valid JSON' },
    });
    expect(calls.trigger).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty body with 400 bad_request', async () => {
    const { app } = makeApp();
    const res = await app.fetch(post('/trigger', ''));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects a valid-JSON non-object body with 400 bad_request', async () => {
    const { app, calls } = makeApp();
    for (const body of ['null', '42', '"taskId"', '[]']) {
      const res = await app.fetch(post('/trigger', body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_request', message: 'request body must be a JSON object' },
      });
    }
    expect(calls.trigger).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still passes a well-formed body through to the kernel', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(post('/trigger', JSON.stringify({ taskId: 't', payload: { a: 1 } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 'run_1', idempotent: false });
    expect(calls.trigger).toEqual([
      { taskId: 't', payload: { a: 1 }, options: undefined, namespace: { projectId: 'default', env: 'prod' } },
    ]);
  });

  it('covers /batch-trigger too', async () => {
    const { app, calls } = makeApp();
    const bad = await app.fetch(post('/batch-trigger', '{items:[]}'));
    expect(bad.status).toBe(400);
    expect(calls.batchTrigger).toHaveLength(0);

    const ok = await app.fetch(post('/batch-trigger', JSON.stringify({ items: [] })));
    expect(ok.status).toBe(200);
    expect(calls.batchTrigger).toEqual([[]]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('covers PATCH /schedules/:id too, without touching the pool', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(patch('/schedules/sch_1', 'not json'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } });
    expect(calls.query).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('PATCH /schedules/:id body fields', () => {
  it('rejects a body without a boolean `enabled`, before any query', async () => {
    // `{}` used to pass undefined → NULL into a NOT NULL column → 500.
    for (const body of ['{}', '{"enabled":null}', '{"enabled":"true"}', '{"enabled":1}']) {
      const { app, calls } = makeApp();
      const res = await app.fetch(patch('/schedules/sch_1', body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_request', message: 'enabled must be a boolean' },
      });
      expect(calls.query).toHaveLength(0);
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still updates on a real boolean, and recomputes next_run_at from it', async () => {
    const { app, calls } = makeApp();
    const off = await app.fetch(patch('/schedules/sch_1', '{"enabled":false}'));
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true });
    const update = calls.query.find((q) => /UPDATE schedules/.test(q.sql));
    expect(update?.params[1]).toBe(false);
    // Disabled schedules have no next occurrence.
    expect(update?.params[2]).toBeNull();

    const on = makeApp();
    expect((await on.app.fetch(patch('/schedules/sch_1', '{"enabled":true}'))).status).toBe(200);
    const enabling = on.calls.query.find((q) => /UPDATE schedules/.test(q.sql));
    expect(enabling?.params[1]).toBe(true);
    expect(enabling?.params[2]).toBeInstanceOf(Date);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('GET /runs query params', () => {
  it('rejects a limit pg would refuse, before it reaches SQL', async () => {
    // -5 → "LIMIT must not be negative"; 1.5 / "abc" → bigint syntax error.
    for (const limit of ['-5', '0', '1.5', 'abc', 'Infinity']) {
      const { app, calls } = makeApp();
      const res = await app.fetch(get(`/runs?limit=${limit}`));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_request', message: 'limit must be an integer >= 1' },
      });
      expect(calls.query).toHaveLength(0);
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('caps an oversized limit instead of refusing it, and defaults when absent', async () => {
    const capped = makeApp();
    expect((await capped.app.fetch(get('/runs?limit=5000'))).status).toBe(200);
    // The query asks for limit + 1 rows to detect a next page.
    expect(capped.calls.query[0]?.params.at(-1)).toBe(201);

    const plain = makeApp();
    expect((await plain.app.fetch(get('/runs?limit='))).status).toBe(200);
    expect(plain.calls.query[0]?.params.at(-1)).toBe(51);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects a cursor whose timestamp half pg cannot parse', async () => {
    for (const cursor of ['abc', 'abc|run_1', 'run_1', '|run_1', '2026-01-01T00:00:00.000Z|']) {
      const { app, calls } = makeApp();
      const res = await app.fetch(get(`/runs?cursor=${encodeURIComponent(cursor)}`));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } });
      expect(calls.query).toHaveLength(0);
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('passes a well-formed cursor through verbatim', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(get('/runs?cursor=2026-07-30T08%3A00%3A00.000Z%7Crun_9'));
    expect(res.status).toBe(200);
    expect(calls.query[0]?.params).toEqual(['default', 'prod', '2026-07-30T08:00:00.000Z', 'run_9', 51]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps microsecond precision on a full-precision cursor', async () => {
    // The Date round-trip used to truncate .123456Z to .123Z, which then
    // silently skipped same-millisecond rows newer than the page's last row.
    const { app, calls } = makeApp();
    const res = await app.fetch(
      get('/runs?cursor=2026-07-30T08%3A00%3A00.123456Z%7Crun_9'),
    );
    expect(res.status).toBe(200);
    expect(calls.query[0]?.params).toEqual([
      'default',
      'prod',
      '2026-07-30T08:00:00.123456Z',
      'run_9',
      51,
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects a bogus status instead of returning an empty page (p2-32)', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(get('/runs?status=bogus'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    // Names the legal set so the caller can fix the typo.
    expect(body.error.message).toContain('running');
    expect(calls.query).toHaveLength(0);
  });

  it('passes a valid status through', async () => {
    const { app, calls } = makeApp();
    expect((await app.fetch(get('/runs?status=running'))).status).toBe(200);
    expect(calls.query[0]?.params).toContain('running');
  });

  it('clamps garbage on the tolerance params of /runs/:id/result (p2-32)', async () => {
    const { app, calls } = makeApp();
    // `?timeoutMs=abc` is a tolerance param: it falls back, not a 400.
    const res = await app.fetch(get('/runs/run_1/result?timeoutMs=abc&pollMs=xyz'));
    expect(res.status).toBe(200);
    const args = calls.waitForResult[0] as unknown[];
    const opts = args[2] as { timeoutMs: number; pollMs: number };
    expect(opts.timeoutMs).toBe(5_000);
    expect(opts.pollMs).toBe(250);
  });

  it('clamps out-of-range integers to the bounds, not to the fallback', async () => {
    const { app, calls } = makeApp();
    // `?timeoutMs=-5` is out of range, not garbage: it clamps to the min
    // rather than answering the fallback.
    const res = await app.fetch(get('/runs/run_1/result?timeoutMs=-5&pollMs=10'));
    expect(res.status).toBe(200);
    const args = calls.waitForResult[0] as unknown[];
    const opts = args[2] as { timeoutMs: number; pollMs: number };
    expect(opts.timeoutMs).toBe(0);
    expect(opts.pollMs).toBe(50);

    // Above the max caps at the max, never an error.
    const high = makeApp();
    expect(
      (await high.app.fetch(get('/runs/run_1/result?timeoutMs=99999999&pollMs=99999999'))).status,
    ).toBe(200);
    const highOpts = (high.calls.waitForResult[0] as unknown[])[2] as {
      timeoutMs: number;
      pollMs: number;
    };
    expect(highOpts.timeoutMs).toBe(30_000);
    expect(highOpts.pollMs).toBe(5_000);
  });
});

/* ------------------------------------------------------- F6: waiter path */

describe('GET /runs/:id/result with a daemon waiter registry (F6)', () => {
  const stubWaiters = () => {
    const registers: unknown[][] = [];
    const waiters = {
      register: async (...args: unknown[]) => {
        registers.push(args);
        return { status: 'completed', output: 'ok' };
      },
      resolve: async () => {},
      pending: () => 0,
      stop: () => {},
    } as unknown as WaiterRegistry;
    return { waiters, registers };
  };

  it('never forwards pollMs to the registry, whatever the query says', async () => {
    const { waiters, registers } = stubWaiters();
    const { app, calls } = makeApp(waiters);
    // Same registry, two pollMs values far apart: both requests must be
    // accepted (no 400 — the query stays legal for old SDKs) and the
    // registration must carry only the real wait budget. The shared sweep is
    // the registry's own fixed interval; a single request cannot tune it,
    // and nothing pretends otherwise in the args.
    expect((await app.fetch(get('/runs/run_1/result?timeoutMs=1000&pollMs=50'))).status).toBe(200);
    expect((await app.fetch(get('/runs/run_1/result?timeoutMs=1000&pollMs=5000'))).status).toBe(200);
    expect(registers).toHaveLength(2);
    for (const args of registers) {
      const opts = args[2] as Record<string, unknown>;
      expect(opts).toEqual({ timeoutMs: 1000 });
      expect('pollMs' in opts).toBe(false);
    }
    // And the kernel poll loop is not used at all on this path.
    expect(calls.waitForResult).toHaveLength(0);
  });
});

describe('GET /runs/:id/result without a waiter registry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function kernelApp() {
    const query = vi.fn(async () => ({
      rows: [{ status: 'running', output: null as unknown, error: null as unknown }],
    }));
    const pool = { query } as unknown as Pool;
    const kernel = createKernel({ pool });
    const app = createApp({ pool, kernel });
    const controller = new AbortController();
    const request = (params = '') => new Request(`http://localhost/api/v1/runs/run_1/result${params}`, {
      signal: controller.signal,
    });
    return { query, pool, kernel, app, controller, request };
  }

  it('pre-abort returns 499 without any database read', async () => {
    const { app, query, controller, request } = kernelApp();
    controller.abort();
    const response = await app.fetch(request());
    expect(response.status).toBe(499);
    expect(await response.text()).toBe('');
    expect(query).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, new Error('client left'), null])('aborts a sleeping kernel wait with reason %s', async (reason) => {
    const { app, query, controller, request } = kernelApp();
    const response = app.fetch(request('?timeoutMs=30000&pollMs=50'));
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);
    controller.abort(reason);
    expect((await response).status).toBe(499);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(query).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a kernel query in flight and handles its late failure', async () => {
    const { app, query, controller, request } = kernelApp();
    let fail!: (error: Error) => void;
    query.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const response = app.fetch(request());
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);
    controller.abort();
    expect((await response).status).toBe(499);
    fail(new Error('late database failure'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(query).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['completed', 'failed', 'canceled'])('preserves the terminal %s response shape', async (status) => {
    const { app, query, request } = kernelApp();
    const result = { status, output: { value: 1 }, error: { name: 'Error', message: 'failed' } };
    query.mockResolvedValueOnce({ rows: [result] });
    const response = await app.fetch(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the timeout response after spending the entire budget', async () => {
    const { app, request, query } = kernelApp();
    const settled = vi.fn();
    const pending = Promise.resolve(app.fetch(request('?timeoutMs=35&pollMs=250'))).then((response) => {
      settled();
      return response;
    });
    await vi.advanceTimersByTimeAsync(34);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'running' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not classify an unrelated AbortError as a client disconnect', async () => {
    const { pool, kernel, controller, request } = kernelApp();
    const failure = new Error('unrelated database failure');
    failure.name = 'AbortError';
    kernel.waitForResult = async () => {
      controller.abort(new Error('client left too'));
      throw failure;
    };
    const app = createApp({ pool, kernel });
    const response = await app.fetch(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'internal_error' } });
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), failure);
  });
});
