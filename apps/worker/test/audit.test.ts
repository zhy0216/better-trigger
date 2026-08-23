/* =============================================================================
   @better-trigger/worker — audit log tests (O6).

   One middleware on the whole /api/v1 surface records one JSON line per
   request (except OPTIONS preflights and /health): requestId, caller, key
   fingerprint, task ids, run ids, status, result and rejection reason. The
   payload is NEVER read into the line, and the Authorization header never
   appears — those two are the acceptance criterion "audit records do not
   leak sensitive payload information".

   Driven through createApp with stub deps; console.log is spied so the
   [audit] lines can be asserted.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { AuditEntry } from '../src/audit';

const SECRET_PAYLOAD = 'super-secret-token-value-12345';

const makeApp = (overrides: Partial<Kernel> = {}) => {
  const kernel = {
    trigger: async () => ({ runId: 'run_1', idempotent: false }),
    batchTrigger: async () => ({ runIds: ['run_1', 'run_2'] }),
    cancelRun: async () => undefined,
    retryRun: async () => ({ runId: 'run_2' }),
    ...overrides,
  } as unknown as Kernel;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return createApp({ kernel, pool });
};

const post = (path: string, body?: unknown, auth?: string) =>
  new Request(`http://localhost:4848${path}`, {
    method: 'POST',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth !== undefined ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

let logSpy: ReturnType<typeof vi.spyOn>;
let savedKey: string | undefined;
let savedRps: string | undefined;
let savedGlobal: string | undefined;
let savedBurst: string | undefined;

beforeEach(() => {
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  savedRps = process.env.BETTER_TRIGGER_RATE_LIMIT_RPS;
  savedGlobal = process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS;
  savedBurst = process.env.BETTER_TRIGGER_RATE_LIMIT_BURST;
  delete process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_RATE_LIMIT_RPS;
  delete process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS;
  delete process.env.BETTER_TRIGGER_RATE_LIMIT_BURST;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
  else process.env.BETTER_TRIGGER_API_KEY = savedKey;
  for (const [name, val] of [
    ['BETTER_TRIGGER_RATE_LIMIT_RPS', savedRps],
    ['BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS', savedGlobal],
    ['BETTER_TRIGGER_RATE_LIMIT_BURST', savedBurst],
  ] as const) {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  }
});

/** The most recent [audit] line produced so far. */
const lastAuditLine = (): AuditEntry => {
  const lines = logSpy.mock.calls
    .map(([arg]: [unknown]) => String(arg))
    .filter((s: string) => s.startsWith('[audit] '));
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!.slice('[audit] '.length)) as AuditEntry;
};

describe('audit — accepted requests', () => {
  it('records a successful trigger: ids, key, caller, result', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'sk-audit-1234567890';
    const app = makeApp();
    const res = await app.fetch(
      post('/api/v1/trigger', { taskId: 'send-email', payload: { to: 'x@y.z' } }, 'sk-audit-1234567890'),
    );
    expect(res.status).toBe(200);

    const line = lastAuditLine();
    expect(line.audit).toBe(true);
    expect(line.method).toBe('POST');
    expect(line.path).toBe('/api/v1/trigger');
    expect(line.endpoint).toBe('trigger');
    expect(line.taskIds).toEqual(['send-email']);
    expect(line.runIds).toEqual(['run_1']);
    expect(line.status).toBe(200);
    expect(line.result).toBe('accepted');
    expect(line.reason).toBeNull();
    expect(line.key).toMatch(/^key_[0-9a-f]{12}$/);
    expect(line.key).not.toContain('sk-audit');
    // In-process fetch has no socket.
    expect(line.caller).toBe('unknown');
    expect(line.requestId).toMatch(/^req_[0-9a-f]{12}$/);
    // The correlation id travels on the response too.
    expect(res.headers.get('x-request-id')).toBe(line.requestId);
  });

  it('records batch-trigger with deduped task ids and the created run ids', async () => {
    const app = makeApp();
    await app.fetch(
      post('/api/v1/batch-trigger', {
        items: [
          { taskId: 'a', payload: null },
          { taskId: 'b', payload: null },
          { taskId: 'a', payload: null },
        ],
      }),
    );
    const line = lastAuditLine();
    expect(line.endpoint).toBe('batch-trigger');
    expect(line.taskIds).toEqual(['a', 'b']);
    expect(line.runIds).toEqual(['run_1', 'run_2']);
  });

  it('records cancel and retry against the run id in the path', async () => {
    const app = makeApp();
    await app.fetch(post('/api/v1/runs/run_42/cancel'));
    expect(lastAuditLine().runIds).toEqual(['run_42']);

    await app.fetch(post('/api/v1/runs/run_42/retry'));
    const line = lastAuditLine();
    expect(line.endpoint).toBe('retry');
    expect(line.runIds).toEqual(['run_42', 'run_2']); // acted on, then created
    expect(line.taskIds).toBeNull();
  });

  it('does not touch key or caller fields when no key is configured', async () => {
    const app = makeApp();
    await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }));
    const line = lastAuditLine();
    expect(line.key).toBeNull();
    expect(line.result).toBe('accepted');
  });
});

describe('audit — rejected requests carry the reason', () => {
  it('records a 401 with reason unauthorized', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'sk-audit-1234567890';
    const app = makeApp();
    await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }, 'sk-wrong-key-123456789'));
    const line = lastAuditLine();
    expect(line.status).toBe(401);
    expect(line.result).toBe('rejected');
    expect(line.reason).toBe('unauthorized');
    expect(line.taskIds).toBeNull(); // rejected bodies are not parsed
  });

  it('records a 429 with reason rate_limited', async () => {
    process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = '1';
    process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '0';
    process.env.BETTER_TRIGGER_RATE_LIMIT_BURST = '1';
    const app = makeApp();
    await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }));
    await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }));
    const line = lastAuditLine();
    expect(line.status).toBe(429);
    expect(line.result).toBe('rejected');
    expect(line.reason).toBe('rate_limited');
  });

  it('records a 400 with reason bad_request (route throw through onError)', async () => {
    const app = makeApp();
    await app.fetch(post('/api/v1/trigger', '{not json'));
    const line = lastAuditLine();
    expect(line.status).toBe(400);
    expect(line.result).toBe('rejected');
    expect(line.reason).toBe('bad_request');
  });

  it('records a 500 with reason internal_error', async () => {
    const app = makeApp({
      trigger: async () => {
        throw new Error('boom');
      },
    });
    await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }));
    const line = lastAuditLine();
    expect(line.status).toBe(500);
    expect(line.result).toBe('rejected');
    expect(line.reason).toBe('internal_error');
  });

  it('records the reason on rejections OUTSIDE the four write endpoints too', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'sk-audit-1234567890';
    const app = makeApp();

    // Unauthenticated read (no key sent): the endpoint is not rate-limited,
    // but the audit line must still say why it was refused.
    await app.fetch(new Request('http://localhost:4848/api/v1/tasks'));
    let line = lastAuditLine();
    expect(line.endpoint).toBeNull();
    expect(line.status).toBe(401);
    expect(line.reason).toBe('unauthorized');

    // Unknown route (authenticated, so auth passes and the 404 envelope
    // carries its own code).
    await app.fetch(
      post('/api/v1/definitely-not-a-route', {}, 'sk-audit-1234567890'),
    );
    line = lastAuditLine();
    expect(line.status).toBe(404);
    expect(line.reason).toBe('not_found');

    // A PATCH whose body fails validation (enabled must be a boolean):
    // refused before any query, still audited with the reason.
    await app.fetch(
      new Request('http://localhost:4848/api/v1/schedules/sched_1?env=prod', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-audit-1234567890' },
        body: JSON.stringify({ enabled: 'yes' }),
      }),
    );
    line = lastAuditLine();
    expect(line.status).toBe(400);
    expect(line.reason).toBe('bad_request');
  });

  it('under NODE_ENV=production the 500 body carries the same requestId as the audit line', async () => {
    process.env.NODE_ENV = 'production';
    try {
      const app = makeApp({
        trigger: async () => {
          throw new Error('boom');
        },
      });
      const res = await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }));
      const body = (await res.json()) as { error: { requestId: string } };
      expect(body.error.requestId).toBe(lastAuditLine().requestId);
    } finally {
      delete process.env.NODE_ENV;
    }
  });
});

describe('audit — no sensitive information', () => {
  it('never writes the payload into the line', async () => {
    const app = makeApp();
    await app.fetch(
      post('/api/v1/trigger', {
        taskId: 't',
        payload: { apiToken: SECRET_PAYLOAD, body: 'x' },
      }),
    );
    const line = lastAuditLine();
    const wire = JSON.stringify(line);
    expect(wire).not.toContain(SECRET_PAYLOAD);
    expect(wire).not.toContain('apiToken');
    expect(line.taskIds).toEqual(['t']);
  });

  it('never writes the Authorization header into the line', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'sk-audit-1234567890';
    const app = makeApp();
    await app.fetch(
      post('/api/v1/trigger', { taskId: 't', payload: null }, 'sk-audit-1234567890'),
    );
    const wire = JSON.stringify(lastAuditLine());
    expect(wire).not.toContain('sk-audit-1234567890');
    expect(wire).not.toContain('Authorization');
  });

  it('never parses the body of a rejected request, so an oversized one is not buffered', async () => {
    process.env.BETTER_TRIGGER_RATE_LIMIT_RPS = '1';
    process.env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS = '0';
    process.env.BETTER_TRIGGER_RATE_LIMIT_BURST = '1';
    const app = makeApp();
    // Exhaust the bucket, then send a rejected request whose body would be
    // expensive to parse — the audit middleware must not read it.
    await app.fetch(post('/api/v1/trigger', { taskId: 't', payload: null }));
    await app.fetch(
      post('/api/v1/trigger', {
        taskId: 't',
        payload: { big: SECRET_PAYLOAD.repeat(1000) },
      }),
    );
    const line = lastAuditLine();
    expect(line.status).toBe(429);
    expect(line.taskIds).toBeNull();
    expect(JSON.stringify(line)).not.toContain(SECRET_PAYLOAD);
  });
});

describe('audit — exempt paths', () => {
  it('does not log /health (polled by every load balancer)', async () => {
    const app = makeApp();
    await app.fetch(new Request('http://localhost:4848/api/v1/health'));
    await app.fetch(new Request('http://localhost:4848/api/v1/health?deep=1'));
    const lines = logSpy.mock.calls
      .map(([arg]: [unknown]) => String(arg))
      .filter((s: string) => s.startsWith('[audit]'));
    expect(lines).toHaveLength(0);
  });

  it('does not log OPTIONS preflights', async () => {
    const app = makeApp();
    await app.fetch(
      new Request('http://localhost:4848/api/v1/trigger', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      }),
    );
    const lines = logSpy.mock.calls
      .map(([arg]: [unknown]) => String(arg))
      .filter((s: string) => s.startsWith('[audit]'));
    expect(lines).toHaveLength(0);
  });

  it('still logs plain reads (a dashboard GET) without ids', async () => {
    const app = makeApp();
    await app.fetch(new Request('http://localhost:4848/api/v1/tasks'));
    const line = lastAuditLine();
    expect(line.method).toBe('GET');
    expect(line.endpoint).toBeNull();
    expect(line.taskIds).toBeNull();
    expect(line.runIds).toBeNull();
    expect(line.result).toBe('accepted');
  });
});
