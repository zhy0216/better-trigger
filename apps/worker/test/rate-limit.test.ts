/* =============================================================================
   @better-trigger/worker — rate-limit tests (O6).

   Two rate-limit classes. The four run-affecting endpoints (trigger /
   batch-trigger / retry / cancel) are token-bucket limited, per key AND per
   endpoint, so a hostile or misconfigured client cannot create runs without
   bound. Every other /api/v1 path is a `read`, bucketed loosely (default
   200/s per key, 1000/s global) so an unbounded read storm cannot starve the
   business pool while a polling dashboard is never throttled. Two buckets
   are consumed per request in each class; both must have a token.

   Driven through createApp with stub deps (no Postgres) and an injected
   clock so refill behaviour is deterministic. Env knobs are read per
   request, so each test sets its own BETTER_TRIGGER_RATE_LIMIT_* values.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { markInternalRequest } from '../src/internal-request';
import {
  endpointOf,
  rateLimitConfigFromEnv,
  TokenBuckets,
  type RateLimitedEndpoint,
} from '../src/rate-limit';

const makeApp = () => {
  const kernel = {
    trigger: async () => ({ runId: 'run_1', idempotent: false }),
    batchTrigger: async () => ({ runIds: ['run_1', 'run_2'] }),
    cancelRun: async () => undefined,
    retryRun: async () => ({ runId: 'run_2' }),
  } as unknown as Kernel;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return createApp({ kernel, pool });
};

const post = (path: string, body?: unknown) =>
  new Request(`http://localhost:4848${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const RATE_ENVS = [
  'BETTER_TRIGGER_RATE_LIMIT_RPS',
  'BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS',
  'BETTER_TRIGGER_RATE_LIMIT_READ_RPS',
  'BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS',
  'BETTER_TRIGGER_RATE_LIMIT_BURST',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of RATE_ENVS) saved[k] = process.env[k];
  for (const k of RATE_ENVS) delete process.env[k];
});

afterEach(() => {
  for (const k of RATE_ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** One token per second per key; the global bucket disabled entirely. */
const perKeyOnly = () => {
  process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = '1';
  process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '0';
  process.env.BETTER_TRIGGER_RATE_LIMIT_BURST = '1';
};

/** A request whose peer socket claims `ip`. */
const postFrom = (ip: string) => ({
  req: post('/api/v1/trigger', { taskId: 't', payload: null }),
  env: { incoming: { socket: { remoteAddress: ip } } },
});

describe('keyless per-IP bucketing (p2-31)', () => {
  beforeEach(() => {
    perKeyOnly();
    delete process.env.BETTER_TRIGGER_API_KEYS;
    delete process.env.BETTER_TRIGGER_API_KEY;
  });

  afterEach(() => {
    delete process.env.BETTER_TRIGGER_API_KEYS;
    delete process.env.BETTER_TRIGGER_API_KEY;
  });

  it('two source addresses get separate per-key buckets when no key is configured', async () => {
    const app = makeApp();
    // A FRESH request per fetch — a Request body can only be consumed once.
    const a = () => postFrom('10.0.0.1');
    const b = () => postFrom('10.0.0.2');
    // A exhausts its bucket: first 200, second 429.
    expect((await app.fetch(a().req, a().env)).status).toBe(200);
    expect((await app.fetch(a().req, a().env)).status).toBe(429);
    // B's bucket is separate: its FIRST request passes even though A is fully
    // exhausted (the p2-31 fix); B's second hits B's own burst cap.
    expect((await app.fetch(b().req, b().env)).status).toBe(200);
    expect((await app.fetch(b().req, b().env)).status).toBe(429);
  });

  it('a configured key keeps the address OUT of the bucket identity', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'k-1';
    const app = makeApp();
    // Same key, two addresses — the per-key bucket is keyed by the KEY, so
    // the second request (from a different address) is still throttled.
    const authedFrom = (ip: string) => ({
      req: new Request(`http://localhost:4848/api/v1/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k-1' },
        body: JSON.stringify({ taskId: 't', payload: null }),
      }),
      env: { incoming: { socket: { remoteAddress: ip } } },
    });
    expect((await app.fetch(authedFrom('10.0.0.1').req, authedFrom('10.0.0.1').env)).status).toBe(200);
    expect((await app.fetch(authedFrom('10.0.0.2').req, authedFrom('10.0.0.2').env)).status).toBe(429);
  });
});

describe('endpointOf', () => {
  it.each<[string, string, RateLimitedEndpoint | 'read' | null]>([
    ['POST', '/api/v1/trigger', 'trigger'],
    ['POST', '/api/v1/batch-trigger', 'batch-trigger'],
    ['POST', '/api/v1/runs/run_1/cancel', 'cancel'],
    ['POST', '/api/v1/runs/run_1/retry', 'retry'],
    ['POST', '/api/v1/runs/run_1/result', 'read'],
    ['GET', '/api/v1/runs/run_1/result', 'read'],
    ['GET', '/api/v1/runs/run_1/record', 'read'],
    ['POST', '/api/v1/runs/run_1/record', 'read'],
    ['GET', '/api/v1/runs', 'read'],
    ['GET', '/api/v1/tasks', 'read'],
    ['GET', '/api/v1/schedules', 'read'],
    ['GET', '/api/v1/workers', 'read'],
    ['GET', '/api/v1/metrics', 'read'],
    ['GET', '/api/v1/health', null],
    ['OPTIONS', '/api/v1/trigger', null],
    ['POST', '/api/v1/not-a-route', 'read'],
  ])('%s %s → %s', (method, path, expected) => {
    expect(endpointOf(method, path)).toBe(expected);
  });
});

describe('TokenBuckets', () => {
  it('allows the burst capacity up front, then refills at the rate', () => {
    let now = 1_000;
    const buckets = new TokenBuckets(() => now);
    expect(buckets.consume('k', 1, 2)).toBe(true);
    expect(buckets.consume('k', 1, 2)).toBe(true);
    expect(buckets.consume('k', 1, 2)).toBe(false);
    now += 1_500; // +1.5 tokens
    expect(buckets.consume('k', 1, 2)).toBe(true); // 1.5 → 0.5
    expect(buckets.consume('k', 1, 2)).toBe(false); // 0.5 < 1
  });

  it('keeps buckets independent per key', () => {
    const buckets = new TokenBuckets(() => 1_000);
    expect(buckets.consume('a', 1, 1)).toBe(true);
    expect(buckets.consume('a', 1, 1)).toBe(false);
    expect(buckets.consume('b', 1, 1)).toBe(true);
  });
});

describe('real concurrency', () => {
  it('admits exactly the burst and rejects the rest when N requests race for the last tokens', async () => {
    process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = '1';
    process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '0';
    process.env.BETTER_TRIGGER_RATE_LIMIT_BURST = '3';
    const app = makeApp();
    // Five in-flight fetches race for a burst of three: the synchronous
    // consume() is atomic per event-loop turn, so exactly three win.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null })),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
  });
});

describe('internal-request exemption (P1-03)', () => {
  it('a marked in-process request bypasses the limiter; an unmarked one still draws the bucket', async () => {
    perKeyOnly();
    const app = makeApp();
    const markedPost = () => {
      const req = post('/api/v1/trigger', { taskId: 't', payload: null });
      markInternalRequest(req);
      return req;
    };
    // Marked requests consume no tokens, so they never 429 regardless of count.
    expect((await app.fetch(markedPost())).status).toBe(200);
    expect((await app.fetch(markedPost())).status).toBe(200);
    // An unmarked request is unaffected: first consumes the single token, next 429s.
    expect((await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }))).status).toBe(
      200,
    );
    expect((await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }))).status).toBe(
      429,
    );
  });
});

describe('per-endpoint rate limit (defaults)', () => {
  it('lets the first request through and answers 429 with the envelope after', async () => {
    perKeyOnly();
    const app = makeApp();
    expect((await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }))).status).toBe(
      200,
    );
    const res = await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toContain('trigger');
  });

  it("does not let one endpoint's bucket leak into another", async () => {
    perKeyOnly();
    const app = makeApp();
    await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }));
    expect((await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }))).status).toBe(
      429,
    );
    // cancel, retry and batch-trigger have their own buckets.
    expect((await app.fetch(post('/api/v1/runs/run_1/cancel'))).status).toBe(200);
    expect((await app.fetch(post('/api/v1/runs/run_1/retry'))).status).toBe(200);
    expect(
      (await app.fetch(post('/api/v1/batch-trigger', { items: [] }))).status,
    ).toBe(200);
  });

  it('refills after the window', async () => {
    vi.useFakeTimers();
    try {
      process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = '1';
      process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '0';
      process.env.BETTER_TRIGGER_RATE_LIMIT_BURST = '1';
      const app = makeApp();
      const hit = async () =>
        (await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }))).status;
      expect(await hit()).toBe(200);
      expect(await hit()).toBe(429);
      vi.advanceTimersByTime(1_000); // the token bucket refills on Date.now()
      expect(await hit()).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loosely buckets reads: a burst over the read rate answers 429, normal reads pass', async () => {
    // Reads share one loose bucket (defaults 200/s per key / 1000/s global),
    // distinct from the write buckets: tightening it must NOT touch writes.
    process.env.BETTER_TRIGGER_RATE_LIMIT_READ_RPS = '1';
    process.env.BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS = '0';
    process.env.BETTER_TRIGGER_RATE_LIMIT_BURST = '1';
    const app = makeApp();
    const get = (path: string) => new Request(`http://localhost:4848${path}`);
    expect((await app.fetch(get('/api/v1/tasks'))).status).toBe(200);
    // Second read, same key: the per-key read bucket is empty → 429.
    const res = await app.fetch(get('/api/v1/tasks'));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
    // /health is exempt even with a depleted read bucket.
    expect((await app.fetch(get('/api/v1/health'))).status).toBe(200);
    // The write buckets were never touched: trigger still has its own token.
    expect((await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }))).status).toBe(
      200,
    );
  });

  it('reads pass without bound when the read buckets are disabled (0)', async () => {
    process.env.BETTER_TRIGGER_RATE_LIMIT_READ_RPS = '0';
    process.env.BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS = '0';
    const app = makeApp();
    const get = (path: string) => new Request(`http://localhost:4848${path}`);
    for (let i = 0; i < 5; i++) {
      expect((await app.fetch(get('/api/v1/tasks'))).status).toBe(200);
    }
  });

  it('default read limits are generous enough that a polling dashboard is never throttled', async () => {
    const app = makeApp();
    const get = (path: string) => new Request(`http://localhost:4848${path}`);
    // ~50 dashboard polls across several read endpoints, all under the 200/s
    // default per-key read rate — every one passes.
    for (let i = 0; i < 50; i++) {
      expect((await app.fetch(get('/api/v1/tasks'))).status).toBe(200);
      expect((await app.fetch(get('/api/v1/runs'))).status).toBe(200);
    }
  });
});

describe('per-key isolation', () => {
  it('one key exhausting its bucket does not starve another key', async () => {
    perKeyOnly();
    const app = makeApp();
    const trigger = (key: string) =>
      new Request('http://localhost:4848/api/v1/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ taskId: 't', payload: null }),
      });
    process.env.BETTER_TRIGGER_API_KEY = 'key-a';
    process.env.BETTER_TRIGGER_API_KEYS = 'key-b';
    expect((await app.fetch(trigger('key-a'))).status).toBe(200);
    expect((await app.fetch(trigger('key-a'))).status).toBe(429);
    // Key B has its own bucket — still green.
    expect((await app.fetch(trigger('key-b'))).status).toBe(200);
    delete process.env.BETTER_TRIGGER_API_KEY;
    delete process.env.BETTER_TRIGGER_API_KEYS;
  });
});

describe('global per-endpoint cap', () => {
  it('binds even across keys', async () => {
    process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = '0';
    process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '1';
    process.env.BETTER_TRIGGER_RATE_LIMIT_BURST = '1';
    process.env.BETTER_TRIGGER_API_KEY = 'key-a';
    process.env.BETTER_TRIGGER_API_KEYS = 'key-b';
    const app = makeApp();
    const trigger = (key: string) =>
      new Request('http://localhost:4848/api/v1/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ taskId: 't', payload: null }),
      });
    expect((await app.fetch(trigger('key-a'))).status).toBe(200);
    // Same endpoint, different key: the per-key bucket is disabled, so the
    // global bucket is the only gate — and it is empty.
    expect((await app.fetch(trigger('key-b'))).status).toBe(429);
    delete process.env.BETTER_TRIGGER_API_KEY;
    delete process.env.BETTER_TRIGGER_API_KEYS;
  });
});

describe('disabling the rate limit', () => {
  it('0 on both knobs lets requests through without bound', async () => {
    process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = '0';
    process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '0';
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }));
      expect(res.status).toBe(200);
    }
  });

  it('falls back to the defaults on garbage input', () => {
    process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = 'banana';
    process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '-3';
    process.env.BETTER_TRIGGER_RATE_LIMIT_READ_RPS = 'NaN';
    process.env.BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS = '12.5';
    process.env.BETTER_TRIGGER_RATE_LIMIT_BURST = 'NaN';
    const cfg = rateLimitConfigFromEnv();
    expect(cfg).toEqual({ rps: 50, globalRps: 200, readRps: 200, readGlobalRps: 1000, burst: 200 });
  });

  it('burst defaults to the larger of the two rates', () => {
    process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = '7';
    process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '12';
    expect(rateLimitConfigFromEnv().burst).toBe(12);
  });
});
