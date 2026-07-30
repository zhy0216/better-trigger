/* =============================================================================
   @better-trigger/worker — request body cap tests (S4).

   Without a cap, `c.req.json()` buffers whatever the caller sends: one 500MB
   POST (a mistyped loop is enough) eats the daemon's heap before any route runs.
   So an oversized body must be refused by the middleware itself — 413 with the
   normal error envelope, the route never entered, and no "unhandled error" log
   (that line means the server is broken, and this is the client's mistake).
   The cap is BETTER_TRIGGER_BODY_LIMIT, read when createApp assembles the app.
   Driven through createApp with stub deps — no Postgres involved.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';

const makeApp = () => {
  const calls: { trigger: unknown[] } = { trigger: [] };
  const kernel = {
    trigger: async (input: unknown) => {
      calls.trigger.push(input);
      return { runId: 'run_1', idempotent: false };
    },
  } as unknown as Kernel;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return { app: createApp({ kernel, pool }), calls };
};

const post = (path: string, body: string) =>
  new Request(`http://localhost/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

/** A trigger body whose serialized size is at least `bytes`. */
const triggerBody = (bytes: number) =>
  JSON.stringify({ taskId: 't', payload: 'x'.repeat(bytes) });

let errorSpy: ReturnType<typeof vi.spyOn>;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_API_KEY;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  delete process.env.BETTER_TRIGGER_BODY_LIMIT;
  if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
  else process.env.BETTER_TRIGGER_API_KEY = savedKey;
});

describe('request body limit', () => {
  it('refuses a body over the default 1MiB with 413 and never enters the route', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(post('/trigger', triggerBody(2 * 1024 * 1024)));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        code: 'payload_too_large',
        message: 'request body must be at most 1048576 bytes',
      },
    });
    expect(calls.trigger).toHaveLength(0);
    // Answered by the middleware, not thrown into onError as a 500.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('leaves an ordinary request completely alone', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(post('/trigger', JSON.stringify({ taskId: 't', payload: { a: 1 } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 'run_1', idempotent: false });
    expect(calls.trigger).toHaveLength(1);
  });

  it('honours BETTER_TRIGGER_BODY_LIMIT', async () => {
    process.env.BETTER_TRIGGER_BODY_LIMIT = '200';
    const { app, calls } = makeApp();

    const big = await app.fetch(post('/trigger', triggerBody(500)));
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({
      error: { code: 'payload_too_large', message: 'request body must be at most 200 bytes' },
    });

    const small = await app.fetch(post('/trigger', JSON.stringify({ taskId: 't' })));
    expect(small.status).toBe(200);
    expect(calls.trigger).toHaveLength(1);
  });

  it('falls back to the default when the env value is garbage', async () => {
    for (const raw of ['0', '-1', 'lots', '']) {
      process.env.BETTER_TRIGGER_BODY_LIMIT = raw;
      const { app } = makeApp();
      const res = await app.fetch(post('/trigger', triggerBody(2 * 1024 * 1024)));
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({
        error: { message: 'request body must be at most 1048576 bytes' },
      });
    }
  });

  it('still lets a bodyless GET through', async () => {
    // The cap is read by createApp, so it has to be set before makeApp() —
    // otherwise this runs under the default 1MiB and proves nothing.
    process.env.BETTER_TRIGGER_BODY_LIMIT = '10';
    const { app } = makeApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/runs'));
    expect(res.status).toBe(200);
  });
});
