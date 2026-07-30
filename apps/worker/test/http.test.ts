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
import type { Kernel } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';

/** Records what the routes reached, so we can assert nothing did on a 400. */
interface Calls {
  trigger: unknown[];
  batchTrigger: unknown[];
  query: { sql: string; params: unknown[] }[];
}

const makeApp = () => {
  const calls: Calls = { trigger: [], batchTrigger: [], query: [] };
  const kernel = {
    trigger: async (input: unknown) => {
      calls.trigger.push(input);
      return { runId: 'run_1', idempotent: false };
    },
    batchTrigger: async (items: unknown) => {
      calls.batchTrigger.push(items);
      return { runIds: ['run_1'] };
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
  return { app: createApp({ kernel, pool }), calls };
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
    expect(calls.trigger).toEqual([{ taskId: 't', payload: { a: 1 }, options: undefined }]);
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

  it('passes a well-formed cursor through, normalized to ISO', async () => {
    const { app, calls } = makeApp();
    const res = await app.fetch(get('/runs?cursor=2026-07-30T08%3A00%3A00.000Z%7Crun_9'));
    expect(res.status).toBe(200);
    expect(calls.query[0]?.params).toEqual(['2026-07-30T08:00:00.000Z', 'run_9', 51]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
