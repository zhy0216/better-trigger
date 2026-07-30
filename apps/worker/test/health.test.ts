/* =============================================================================
   @better-trigger/worker — health probe tests (O5).

   /health used to answer `{ ok: true }` without touching Postgres, so
   "HTTP process alive, database gone" — the one failure a probe exists to
   catch — read as healthy. The shallow answer stays as the liveness probe;
   ?deep=1 is the readiness one: SELECT 1 under a deadline, pool counters, 503
   when the DB does not answer.

   Both live on /api/v1/health because that exact path is what middleware.ts
   opens to unauthenticated callers, so the 503 must stay a 503 there too.
   Driven through createApp with stub deps: no Postgres involved.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';

const kernel = {} as unknown as Kernel;

/** An app whose pool answers `query` with `impl`, and carries pg's counters. */
const makeApp = (impl: () => Promise<unknown>, counts?: Partial<Record<string, number>>) => {
  const pool = {
    query: impl,
    totalCount: 3,
    idleCount: 2,
    waitingCount: 0,
    ...counts,
  } as unknown as Pool;
  return createApp({ kernel, pool });
};

const healthy = () => makeApp(async () => ({ rows: [{ '?column?': 1 }] }));

/** A realistic pg failure: it names the host it could not reach. */
const dbDown = () =>
  makeApp(async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.4:5432');
  });

const get = (path: string) => new Request(`http://localhost:4848${path}`);

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
  else process.env.BETTER_TRIGGER_API_KEY = savedKey;
});

describe('shallow /health (liveness)', () => {
  it('answers 200 without touching the database', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const res = await makeApp(query).fetch(get('/api/v1/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '0.1.0' });
    expect(query).not.toHaveBeenCalled();
  });

  it('stays 200 while the database is down', async () => {
    // The whole point of keeping it: a liveness probe answering 503 gets the
    // container killed and restarted over a failure a restart cannot fix.
    const res = await dbDown().fetch(get('/api/v1/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '0.1.0' });
  });
});

describe('deep /health?deep=1 (readiness)', () => {
  it('runs SELECT 1 and reports the pool counters', async () => {
    const query = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
    const app = makeApp(query, { totalCount: 5, idleCount: 1, waitingCount: 2 });
    const res = await app.fetch(get('/api/v1/health?deep=1'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: '0.1.0',
      db: { ok: true },
      pool: { total: 5, idle: 1, waiting: 2 },
    });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('accepts deep=true as well', async () => {
    const res = await healthy().fetch(get('/api/v1/health?deep=true'));
    expect(res.status).toBe(200);
    expect((await res.json()) as { db: unknown }).toMatchObject({ db: { ok: true } });
  });

  it('answers 503 when the query throws', async () => {
    const res = await dbDown().fetch(get('/api/v1/health?deep=1'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      version: '0.1.0',
      db: { ok: false, error: 'query_failed' },
      pool: { total: 3, idle: 2, waiting: 0 },
    });
  });

  it('leaks neither the host nor the pg message', async () => {
    // The endpoint is unauthenticated by design, so its body is public.
    const res = await dbDown().fetch(get('/api/v1/health?deep=1'));
    const wire = JSON.stringify(await res.json());
    expect(wire).not.toContain('10.0.0.4');
    expect(wire).not.toContain('ECONNREFUSED');
  });

  it('counts a hung query as unhealthy instead of hanging with it', async () => {
    vi.useFakeTimers();
    try {
      // A dead peer or a saturated pool leaves the query pending forever.
      const app = makeApp(() => new Promise(() => {}));
      const pending = app.fetch(get('/api/v1/health?deep=1'));
      await vi.advanceTimersByTimeAsync(2000);
      const res = await pending;

      expect(res.status).toBe(503);
      expect((await res.json()) as { db: unknown }).toMatchObject({
        ok: false,
        db: { ok: false, error: 'timeout' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // There is deliberately no test for "the hung query rejects after the
  // deadline takes the daemon down". That cannot happen and so cannot regress:
  // `Promise.race` subscribes to *every* input, so the loser's late rejection
  // is already observed by the race itself — it never reaches
  // process.on('unhandledRejection'), whatever probeDb does with the winner.
  // A test asserting that handler stays silent is green against any
  // implementation, i.e. it is not a test.

  it('disarms the deadline once the query answers', async () => {
    // The deadline is a live setTimeout, and a pending timer holds the event
    // loop open: forget the clearTimeout and every cheap probe pins the process
    // for the full 2s, so a SIGTERM arriving just after a healthcheck waits on
    // a timer nobody needs any more.
    vi.useFakeTimers();
    try {
      const res = await healthy().fetch(get('/api/v1/health?deep=1'));
      expect(res.status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms the deadline once the query fails', async () => {
    vi.useFakeTimers();
    try {
      const res = await dbDown().fetch(get('/api/v1/health?deep=1'));
      expect(res.status).toBe(503);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('auth', () => {
  it('keeps the deep probe open: a healthcheck has no API key to send', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'sk-local-abcdefghijklmnop';
    const res = await healthy().fetch(get('/api/v1/health?deep=1'));
    expect(res.status).toBe(200);
  });

  it('answers 503, not 401, when the DB is down and a key is configured', async () => {
    // Same path as the shallow probe, so the auth skip must not start
    // depending on the response — otherwise the probe reports the wrong fault.
    process.env.BETTER_TRIGGER_API_KEY = 'sk-local-abcdefghijklmnop';
    const res = await dbDown().fetch(get('/api/v1/health?deep=1'));
    expect(res.status).toBe(503);
  });
});
