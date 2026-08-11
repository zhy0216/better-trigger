/* =============================================================================
   @better-trigger/worker — error envelope tests (S5).

   A non-KernelError carries whatever pg or the connection layer wrote into it:
   table, column and constraint names, sometimes a host or a connection-string
   fragment. Locally that is the point; under NODE_ENV=production it is free
   internal-structure disclosure, so the body must be generic and carry a
   requestId that appears verbatim in the server log line holding the real
   error. KernelError messages are ours and stay identical in both modes.
   Driven through createApp with stub deps — no Postgres involved.
   ============================================================================= */
import type { Pool } from 'pg';
import { KernelError, type Kernel, type KernelErrorCode } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';

/** An app whose /trigger always fails with `err`. */
const makeApp = (err: Error) => {
  const kernel = {
    trigger: async () => {
      throw err;
    },
  } as unknown as Kernel;
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  return createApp({ kernel, pool });
};

const post = () =>
  new Request('http://localhost/api/v1/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: 't', payload: {} }),
  });

/** A realistic pg failure: names the table, the column and the constraint. */
const pgError = () =>
  new Error(
    'insert or update on table "better_trigger_runs" violates foreign key ' +
      'constraint "runs_task_id_fkey" (host=db.internal.example)',
  );

let errorSpy: ReturnType<typeof vi.spyOn>;
let savedEnv: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  savedEnv = process.env.NODE_ENV;
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_API_KEY;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  if (savedEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv;
  if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
  else process.env.BETTER_TRIGGER_API_KEY = savedKey;
});

describe('internal_error in production', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  it('replaces the raw message with a generic one plus a requestId', async () => {
    const res = await makeApp(pgError()).fetch(post());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('internal error');
    expect(body.error.requestId).toMatch(/^req_[0-9a-f]{12}$/);
    // Nothing about the schema or the host survives into the response.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('better_trigger_runs');
    expect(wire).not.toContain('runs_task_id_fkey');
    expect(wire).not.toContain('db.internal.example');
  });

  it('logs the full error under the same requestId', async () => {
    const err = pgError();
    const res = await makeApp(err).fetch(post());
    const body = (await res.json()) as { error: { requestId: string } };

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [line, logged] = errorSpy.mock.calls[0] as [string, unknown];
    expect(line).toContain(body.error.requestId);
    expect(logged).toBe(err);
  });

  it('gives each failure its own requestId', async () => {
    const app = makeApp(pgError());
    const first = (await (await app.fetch(post())).json()) as { error: { requestId: string } };
    const second = (await (await app.fetch(post())).json()) as { error: { requestId: string } };
    expect(first.error.requestId).not.toBe(second.error.requestId);
  });

  it('still returns a KernelError message verbatim', async () => {
    const res = await makeApp(new KernelError('bad_request', 'taskId is required')).fetch(post());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'bad_request', message: 'taskId is required' },
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('maps serialization_error to 400 with the stable envelope', async () => {
    const err = new KernelError('serialization_error', 'payload is not JSON-serializable: boom');
    const res = await makeApp(err).fetch(post());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'serialization_error', message: err.message },
    });
    // Kernel-error messages are ours: no production redaction, no requestId.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('internal_error outside production', () => {
  it('keeps the raw message, as before', async () => {
    process.env.NODE_ENV = 'development';
    const err = pgError();
    const res = await makeApp(err).fetch(post());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal_error', message: err.message },
    });
    expect(errorSpy).toHaveBeenCalledWith('[server] unhandled error:', err);
  });

  it('keeps the raw message when NODE_ENV is unset', async () => {
    delete process.env.NODE_ENV;
    const err = pgError();
    const res = await makeApp(err).fetch(post());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal_error', message: err.message },
    });
  });

  it('falls back to a generic message when the error has none', async () => {
    process.env.NODE_ENV = 'development';
    const res = await makeApp(new Error('')).fetch(post());
    expect(await res.json()).toEqual({
      error: { code: 'internal_error', message: 'internal error' },
    });
  });

  it('still returns a KernelError message verbatim', async () => {
    process.env.NODE_ENV = 'development';
    const res = await makeApp(new KernelError('bad_request', 'taskId is required')).fetch(post());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'bad_request', message: 'taskId is required' },
    });
  });
});

describe('STATUS_BY_CODE — the full kernel-code → HTTP-status table', () => {
  const CODES: Array<[KernelErrorCode, number]> = [
    ['bad_request', 400],
    ['serialization_error', 400],
    ['not_found', 404],
    ['task_not_found', 404],
    ['run_not_running', 409],
    ['stale_lease', 409],
    ['conflict', 409],
    ['payload_too_large', 413],
  ];

  it.each(CODES)('maps %s → %i with the stable envelope', async (code, status) => {
    const res = await makeApp(new KernelError(code, `boom: ${code}`)).fetch(post());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({
      error: { code, message: `boom: ${code}` },
    });
    // Kernel-code answers are ours: never redacted, never a requestId.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('leaves a code outside the table to fall through to internal_error', async () => {
    const res = await makeApp(new KernelError('unknown_code' as never, 'x')).fetch(post());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal_error', message: 'x' },
    });
  });
});
