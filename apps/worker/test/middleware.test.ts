/* =============================================================================
   @better-trigger/worker — CORS allowlist tests (S2).

   The API is unauthenticated by default, so `origin: '*'` made every page the
   user visits a client of it: a cross-origin POST /api/v1/trigger to
   http://localhost:4848 would sail through the preflight and run a task. Only
   the dashboard's own origins (loopback, any port) may be reflected back, plus
   whatever --cors-origin lists.

   The interesting failures are the near-misses — `http://localhost.evil.com`
   and `http://localhost@evil.com` both contain "localhost" and neither is one —
   which is why the check parses the origin instead of matching a pattern.

   The allowlist alone only covers half of it: a cross-origin POST whose
   Content-Type is text/plain is a *simple request* and never gets preflighted,
   so it reaches the route and runs the task no matter what the allowlist says
   — the browser only withholds the response. Hence the media-type block below,
   which is the part that actually stops the trigger.

   Driven through createApp with stub deps: no Postgres involved. The last block
   spawns the real CLI (still no Postgres — it never gets past --no-migrate) to
   prove --cors-origin is wired to setCorsOrigins at all.
   ============================================================================= */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { allowedOrigin, parseOriginList, setCorsOrigins } from '../src/middleware';

const makeApp = () => {
  const kernel = {
    trigger: async () => ({ runId: 'run_1', idempotent: false }),
  } as unknown as Kernel;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return createApp({ kernel, pool });
};

/** A real preflight: what the browser sends before a JSON POST. */
const preflight = (origin: string) =>
  new Request('http://localhost:4848/api/v1/trigger', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });

const post = (origin?: string) =>
  new Request('http://localhost:4848/api/v1/trigger', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ taskId: 't', payload: null }),
  });

const LOOPBACK = [
  'http://localhost:5173', // vite dev
  'http://localhost:4848', // the daemon serving the dashboard itself
  'http://127.0.0.1:4848',
  'http://[::1]:4848',
  'https://localhost:8443',
  'http://localhost', // default port
];

const HOSTILE = [
  'http://localhost.evil.com', // the substring trap
  'https://localhost.evil.com',
  'http://evil.com/?next=http://localhost:4848',
  'http://localhost@evil.com', // userinfo, host is evil.com
  'http://evil.localhost.com',
  'https://evil.com',
  'null', // file:// and sandboxed iframes
];

beforeEach(() => setCorsOrigins([]));
afterEach(() => {
  setCorsOrigins([]);
  delete process.env.BETTER_TRIGGER_CORS_ORIGIN;
});

describe('CORS allowlist', () => {
  it('reflects loopback origins on any port', async () => {
    const app = makeApp();
    for (const origin of LOOPBACK) {
      const res = await app.fetch(preflight(origin));
      expect(res.status, origin).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBe(origin);
    }
  });

  it('refuses origins that merely contain "localhost"', async () => {
    const app = makeApp();
    for (const origin of HOSTILE) {
      expect(allowedOrigin(origin), origin).toBeNull();
      const res = await app.fetch(preflight(origin));
      // The preflight still answers, but without the one header that makes the
      // browser hand the response to the page.
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBeNull();
    }
  });

  it('does not leak the allow header onto the actual cross-origin POST', async () => {
    const app = makeApp();
    const res = await app.fetch(post('https://evil.com'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers the allowed preflight with the methods and headers the dashboard needs', async () => {
    const app = makeApp();
    const res = await app.fetch(preflight('http://localhost:5173'));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('leaves clients that send no Origin alone', async () => {
    const app = makeApp();
    const res = await app.fetch(post());
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows exactly what --cors-origin lists', async () => {
    setCorsOrigins(['https://ops.example.com', 'http://tools.internal:9000']);
    const app = makeApp();
    for (const origin of ['https://ops.example.com', 'http://tools.internal:9000']) {
      const res = await app.fetch(preflight(origin));
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBe(origin);
    }
    // A neighbour of an allowed origin is still a different origin.
    for (const origin of [
      'http://ops.example.com', // scheme
      'https://ops.example.com:8443', // port
      'https://ops.example.com.evil.com', // suffix
    ]) {
      const res = await app.fetch(preflight(origin));
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBeNull();
    }
  });

  it('reads BETTER_TRIGGER_CORS_ORIGIN for an embedded app the CLI never configured', () => {
    expect(allowedOrigin('https://a.example.com')).toBeNull();
    process.env.BETTER_TRIGGER_CORS_ORIGIN = 'https://a.example.com, https://b.example.com';
    expect(allowedOrigin('https://a.example.com')).toBe('https://a.example.com');
    expect(allowedOrigin('https://b.example.com')).toBe('https://b.example.com');
    expect(allowedOrigin('https://c.example.com')).toBeNull();
  });

  it('opens up completely only when asked with *', async () => {
    setCorsOrigins(['*']);
    const app = makeApp();
    const res = await app.fetch(preflight('https://evil.com'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://evil.com');
  });

  it('normalizes configured origins (case, trailing path, whitespace)', () => {
    setCorsOrigins(parseOriginList(' HTTPS://Ops.Example.com/dashboard , '));
    expect(allowedOrigin('https://ops.example.com')).toBe('https://ops.example.com');
  });
});

/* ------------------------------------------------------------------ */

/** Same stubs, but recording: "did the task run" is the assertion that counts. */
const makeRecordingApp = () => {
  const calls: { trigger: unknown[]; cancel: string[] } = { trigger: [], cancel: [] };
  const kernel = {
    trigger: async (input: unknown) => {
      calls.trigger.push(input);
      return { runId: 'run_1', idempotent: false };
    },
    cancelRun: async (id: string) => {
      calls.cancel.push(id);
    },
  } as unknown as Kernel;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return { app: createApp({ kernel, pool }), calls };
};

/** What a page on evil.com can send without ever asking for a preflight. */
const simplePost = (contentType?: string) => {
  const json = JSON.stringify({ taskId: 'send-money', payload: { to: 'evil' } });
  return new Request('http://localhost:4848/api/v1/trigger', {
    method: 'POST',
    headers: {
      Origin: 'https://evil.com',
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    // A string body makes fetch fill in text/plain by itself, so the bytes form
    // is how "no Content-Type at all" gets expressed.
    body: contentType ? json : new TextEncoder().encode(json),
  });
};

describe('cross-origin simple requests', () => {
  it('refuses a body that is not announced as JSON — and runs nothing', async () => {
    // The three Content-Types a form/fetch can set without a preflight, plus
    // the header omitted entirely.
    for (const type of [
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      undefined,
    ]) {
      const { app, calls } = makeRecordingApp();
      const res = await app.fetch(simplePost(type));
      expect(res.status, String(type)).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_request', message: 'Content-Type must be application/json' },
      });
      // The one that matters: the response being unreadable is not enough, the
      // task must not have been triggered in the first place.
      expect(calls.trigger, String(type)).toHaveLength(0);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('lets application/json through, with or without parameters', async () => {
    for (const type of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) {
      const { app, calls } = makeRecordingApp();
      const res = await app.fetch(
        new Request('http://localhost:4848/api/v1/trigger', {
          method: 'POST',
          headers: { 'Content-Type': type },
          body: JSON.stringify({ taskId: 't', payload: null }),
        }),
      );
      expect(res.status, type).toBe(200);
      expect(calls.trigger, type).toHaveLength(1);
    }
  });

  it('leaves body-less POSTs alone — they have no Content-Type to check', async () => {
    const { app, calls } = makeRecordingApp();
    const res = await app.fetch(
      new Request('http://localhost:4848/api/v1/runs/run_1/cancel', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    expect(calls.cancel).toEqual(['run_1']);
  });
});

/* ------------------------------------------------------------------ */

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/** An OS-assigned port, handed back the moment before the daemon claims it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe('--cors-origin wiring', () => {
  it(
    'reaches the middleware through the real CLI',
    async () => {
      // Every other test in this file calls setCorsOrigins() itself, so none of
      // them would notice main.ts dropping the call.
      const port = await freePort();
      const clean = { ...process.env };
      delete clean.BETTER_TRIGGER_CORS_ORIGIN;
      delete clean.BETTER_TRIGGER_API_KEY;
      const child = spawn(
        'bun',
        [
          MAIN,
          '--no-migrate', // never connects: the API is up before any query.
          '--reaper-interval-ms',
          '3600000',
          '--port',
          String(port),
          '--cors-origin',
          'https://ops.example.com',
        ],
        {
          env: { ...clean, DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent' },
          stdio: 'ignore',
        },
      );
      try {
        const base = `http://127.0.0.1:${port}/api/v1`;
        const deadline = Date.now() + 20_000;
        for (;;) {
          try {
            await fetch(`${base}/health`);
            break;
          } catch {
            if (Date.now() > deadline) throw new Error('daemon never came up');
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        const preflight = (origin: string) =>
          fetch(`${base}/trigger`, {
            method: 'OPTIONS',
            headers: {
              Origin: origin,
              'Access-Control-Request-Method': 'POST',
              'Access-Control-Request-Headers': 'content-type',
            },
          });
        const allowed = await preflight('https://ops.example.com');
        expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
          'https://ops.example.com',
        );
        const refused = await preflight('https://evil.com');
        expect(refused.headers.get('Access-Control-Allow-Origin')).toBeNull();
      } finally {
        child.kill('SIGKILL');
      }
    },
    30_000,
  );
});
