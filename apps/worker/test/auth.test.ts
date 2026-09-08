/* =============================================================================
   @better-trigger/worker — bearer auth tests (S3).

   The key check used `!==`, which short-circuits at the first differing byte:
   the response time tells the caller how long a prefix it got right, and the
   key falls out one byte at a time. It is now a length check followed by
   crypto.timingSafeEqual.

   Two things are asserted, and the second is the one that guards the fix: the
   accept/reject *behaviour* the change had to keep intact, and — because
   `token === apiKey` reproduces that behaviour exactly, green tests and all —
   that the comparison actually goes through timingSafeEqual. Timing itself is
   not something a unit test can measure honestly; which function ran is.

   Driven through createApp with stub deps: no Postgres involved.
   ============================================================================= */
import { Buffer } from 'node:buffer';
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wraps the real timingSafeEqual instead of replacing it, so every other test
// in this file still runs against the genuine comparison.
const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return {
    ...actual,
    default: actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqualSpy(a, b);
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { createApp } from '../src/app';
import { keyFingerprint, setCorsOrigins } from '../src/middleware';
import type { AuditEntry } from '../src/audit';

const KEY = 'sk-local-abcdefghijklmnop';

const makeApp = () => {
  const kernel = {
    trigger: async () => ({ runId: 'run_1', idempotent: false }),
  } as unknown as Kernel;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return createApp({ kernel, pool });
};

const trigger = (auth?: string) =>
  new Request('http://localhost:4848/api/v1/trigger', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({ taskId: 't', payload: null }),
  });

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  process.env.BETTER_TRIGGER_API_KEY = KEY;
  timingSafeEqualSpy.mockClear();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
  else process.env.BETTER_TRIGGER_API_KEY = savedKey;
});

describe('bearer auth', () => {
  it('accepts the exact key', async () => {
    const res = await makeApp().fetch(trigger(`Bearer ${KEY}`));
    expect(res.status).toBe(200);
  });

  it('accepts the scheme in any case (RFC 7235)', async () => {
    const app = makeApp();
    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
      const res = await app.fetch(trigger(`${scheme} ${KEY}`));
      expect(res.status, scheme).toBe(200);
    }
  });

  it('rejects near-misses of every shape', async () => {
    const app = makeApp();
    const wrong = [
      `Bearer ${KEY.slice(0, -1)}x`, // same length, last byte off
      `Bearer x${KEY.slice(1)}`, // same length, first byte off
      `Bearer ${KEY.slice(0, 10)}`, // a correct prefix — the timing attack's prize
      `Bearer ${KEY}x`, // correct key plus a byte
      `Bearer ${KEY.toUpperCase()}`, // case
      `Basic ${KEY}`,
      KEY, // no scheme at all
      'Bearer ',
      'Bearer',
      '',
    ];
    for (const header of wrong) {
      const res = await app.fetch(trigger(header));
      expect(res.status, header).toBe(401);
      expect(await res.json(), header).toEqual({
        error: { code: 'unauthorized', message: 'invalid or missing API key' },
      });
    }
  });

  it('rejects a missing Authorization header', async () => {
    const res = await makeApp().fetch(trigger());
    expect(res.status).toBe(401);
  });

  it('keeps /health open so a liveness probe needs no key', async () => {
    const res = await makeApp().fetch(new Request('http://localhost:4848/api/v1/health'));
    expect(res.status).toBe(200);
  });

  it('is a no-op when no key is configured', async () => {
    delete process.env.BETTER_TRIGGER_API_KEY;
    const app = makeApp();
    expect((await app.fetch(trigger())).status).toBe(200);
    // A key nobody asked for is not a reason to refuse either.
    expect((await app.fetch(trigger('Bearer whatever'))).status).toBe(200);
  });

  it('compares bytes, not UTF-16 units', async () => {
    // 'é' is one UTF-16 unit but two UTF-8 bytes: a length check written
    // against string.length would call these a match and hand timingSafeEqual
    // two buffers of different sizes — it throws on that, so the first miss
    // would come back 500 instead of 401.
    //
    // Only misses are asserted. Header values are ByteStrings, and off a real
    // socket Node decodes those bytes as latin-1: a client sending 'clé' as
    // UTF-8 arrives as 'clÃ©', so a non-ASCII key cannot be matched over the
    // wire at all. In-process `new Request` keeps the 'é' whole, so a 200 here
    // would assert something no real client can do. Both 401s hold either way.
    process.env.BETTER_TRIGGER_API_KEY = 'clé-key-ok';
    const app = makeApp();
    expect((await app.fetch(trigger('Bearer cle-key-ok'))).status).toBe(401);
    expect((await app.fetch(trigger('Bearer clé-kex-ok'))).status).toBe(401);
  });
});

/*
 * Everything above passes just as well against `token === apiKey` — accepting
 * the right key and rejecting the wrong ones is not what S3 changed. What it
 * changed is *how* the rejection is reached, and the only handle a unit test
 * has on that is which function did the comparing.
 */
describe('constant-time compare', () => {
  it('rejects a same-length wrong key through timingSafeEqual, not ===', async () => {
    const wrong = `${KEY.slice(0, -1)}x`;
    const res = await makeApp().fetch(trigger(`Bearer ${wrong}`));

    expect(res.status).toBe(401);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    // Both buffers whole: a comparison over a prefix or a hash of one side
    // would not be the thing S3 asked for.
    expect(timingSafeEqualSpy).toHaveBeenCalledWith(
      Buffer.from(wrong, 'utf8'),
      Buffer.from(KEY, 'utf8'),
    );
  });

  it('runs the full compare on the accepting path too', async () => {
    const res = await makeApp().fetch(trigger(`Bearer ${KEY}`));
    expect(res.status).toBe(200);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('answers a length mismatch without calling it', async () => {
    // timingSafeEqual throws on differing lengths, so the length check has to
    // come first — the length leaks, which is the accepted trade.
    const res = await makeApp().fetch(trigger(`Bearer ${KEY}xx`));
    expect(res.status).toBe(401);
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });
});

describe.each(['cancel', 'retry'] as const)('%s origin/auth/rate-limit ordering', (action) => {
  beforeEach(() => {
    setCorsOrigins([]);
    vi.stubEnv('BETTER_TRIGGER_API_KEYS', undefined);
    vi.stubEnv('BETTER_TRIGGER_CORS_ORIGIN', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const recordingApp = () => {
    const operation = vi.fn(async () => ({ runId: 'run_origin_retry' }));
    const kernel = { cancelRun: operation, retryRun: operation } as unknown as Kernel;
    const pool = { query: vi.fn() } as unknown as Pool;
    return { app: createApp({ kernel, pool }), operation };
  };
  const request = (origin?: string, authorization?: string) => new Request(
    `https://dashboard.example/api/v1/runs/run_origin_auth/${action}`,
    {
      method: 'POST',
      headers: {
        ...(origin === undefined ? {} : { Origin: origin }),
        ...(authorization === undefined ? {} : { Authorization: authorization }),
      },
    },
  );

  it('authenticates first and audits a valid key rejected by the origin gate', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, operation } = recordingApp();
    for (const origin of ['https://dashboard.example', 'https://untrusted.example', undefined]) {
      for (const authorization of [undefined, 'Bearer wrong-key']) {
        const res = await app.fetch(request(origin, authorization));
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
      }
    }
    const denied = await app.fetch(request('https://untrusted.example', `Bearer ${KEY}`));
    expect(denied.status).toBe(403);
    expect(operation).not.toHaveBeenCalled();
    const line = String(log.mock.calls.at(-1)![0]);
    const entry = JSON.parse(line.slice('[audit] '.length)) as AuditEntry;
    expect(entry).toMatchObject({
      key: keyFingerprint(KEY), status: 403, result: 'rejected', reason: 'origin_not_allowed',
      requestId: denied.headers.get('x-request-id'),
    });
    expect(line).not.toContain(KEY);
    const accepted = await app.fetch(request('https://dashboard.example', `Bearer ${KEY}`));
    expect(accepted.status).toBe(200);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([
    { keyed: true, rps: '1', globalRps: '0' },
    { keyed: true, rps: '0', globalRps: '1' },
    { keyed: false, rps: '1', globalRps: '0' },
    { keyed: false, rps: '0', globalRps: '1' },
  ])('preserves the run budget and enforces its limit: %j', async ({ keyed, rps, globalRps }) => {
    // Freeze only the bucket clock: async response/audit streams still use
    // real timers, and a slow CI host cannot refill the one-token budget.
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    vi.stubEnv('BETTER_TRIGGER_RATE_LIMIT_RPS', rps);
    vi.stubEnv('BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS', globalRps);
    vi.stubEnv('BETTER_TRIGGER_RATE_LIMIT_BURST', '1');
    if (!keyed) delete process.env.BETTER_TRIGGER_API_KEY;
    const authorization = keyed ? `Bearer ${KEY}` : undefined;
    const { app, operation } = recordingApp();
    for (const origin of ['https://untrusted.example', 'null']) {
      expect((await app.fetch(request(origin, authorization))).status).toBe(403);
    }
    expect(operation).not.toHaveBeenCalled();
    expect((await app.fetch(request('https://dashboard.example', authorization))).status).toBe(200);
    expect(operation).toHaveBeenCalledTimes(1);
    // Omitting Origin is compatible with SDK/curl; it does not bypass limits.
    const limited = await app.fetch(request(undefined, authorization));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
