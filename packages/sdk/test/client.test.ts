/* =============================================================================
   better-trigger — HTTP transport unit tests.

   The interesting behaviour is the error mapping (client.ts toError): a code
   from the kernel family must come back out of the wire as a KernelError with
   the SAME code, so `err.code === 'task_not_found'` reads identically whether
   the kernel was in-process or across HTTP. Everything else must degrade to
   HttpError with the status attached. No daemon, no Postgres — `fetch` is
   injected.
   ============================================================================= */
import { KernelError, type KernelErrorCode } from '@better-trigger/core';
import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError } from '../src/client';

/** A fetch stub that answers every call with `res` and records the calls. */
function stubFetch(res: Response | (() => Response | Promise<Response>)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (input: any, init: any) => {
    calls.push({ url: String(input), init: init ?? {} });
    return typeof res === 'function' ? res() : res;
  };
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

/** JSON error envelope, exactly what apps/worker's onError emits. */
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fetchImpl: typeof globalThis.fetch, url = 'http://daemon.test:4848') {
  return new HttpClient({ url, fetch: fetchImpl });
}

describe('HttpClient — construction', () => {
  it('requires a url', () => {
    expect(() => new HttpClient({ url: '' })).toThrow(/"url" is required/);
  });

  it('strips trailing slashes so /api/v1 does not double up', () => {
    const { fetch, calls } = stubFetch(new Response(null, { status: 204 }));
    const c = new HttpClient({ url: 'http://daemon.test:4848///', fetch });
    expect(c.baseUrl).toBe('http://daemon.test:4848');
    return c.request('/health').then(() => {
      expect(calls[0].url).toBe('http://daemon.test:4848/api/v1/health');
    });
  });
});

describe('HttpClient — request shape', () => {
  it('sends the api key as a bearer token and JSON-encodes the body', async () => {
    const { fetch, calls } = stubFetch(new Response('{"ok":true}', { status: 200 }));
    const c = new HttpClient({ url: 'http://daemon.test:4848', apiKey: 'k-1', fetch });
    await c.request('/trigger', { method: 'POST', body: { taskId: 'a' } });

    const [call] = calls;
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe('{"taskId":"a"}');
    expect(call.init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer k-1',
    });
  });

  it('omits Content-Type (and the body) when there is nothing to send', async () => {
    const { fetch, calls } = stubFetch(new Response('[]', { status: 200 }));
    await client(fetch).request('/runs');
    expect(calls[0].init.headers).toEqual({});
    expect(calls[0].init.body).toBeUndefined();
  });

  it('parses a JSON body and returns undefined for 204', async () => {
    const ok = stubFetch(new Response('{"id":"run_1"}', { status: 200 }));
    await expect(client(ok.fetch).request('/runs/run_1')).resolves.toEqual({ id: 'run_1' });

    const empty = stubFetch(new Response(null, { status: 204 }));
    await expect(client(empty.fetch).request('/runs/run_1/cancel')).resolves.toBeUndefined();
  });
});

describe('HttpClient — error mapping', () => {
  const kernelCodes = [
    ['not_found', 404],
    ['run_not_running', 409],
    ['stale_lease', 409],
    ['task_not_found', 404],
    ['bad_request', 400],
    ['conflict', 409],
  ] as const;

  // The list above restates client.ts's KERNEL_CODES, which restates core's
  // KernelErrorCode. Pin them together at the type level so adding a code to
  // core and forgetting the SDK fails typecheck instead of silently mapping to
  // HttpError.
  it('covers the KernelErrorCode union exactly', () => {
    type Listed = (typeof kernelCodes)[number][0];
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
    const exhaustive: Exact<Listed, KernelErrorCode> = true;
    expect(exhaustive).toBe(true);
  });

  it.each(kernelCodes)('rethrows %s as a KernelError with the code intact', async (code, status) => {
    const { fetch } = stubFetch(errorResponse(status, code, `boom: ${code}`));
    const err = await client(fetch)
      .request('/trigger', { method: 'POST', body: {} })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).code).toBe(code);
    expect((err as KernelError).message).toBe(`boom: ${code}`);
    expect((err as KernelError).name).toBe('KernelError');
  });

  it('keeps codes outside the kernel family as HttpError', async () => {
    const { fetch } = stubFetch(errorResponse(500, 'internal_error', 'unhandled error'));
    const err = await client(fetch).request('/runs').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(KernelError);
    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).code).toBe('internal_error');
    expect((err as HttpError).message).toBe('unhandled error');
  });

  it('does not promote an unknown code to a KernelError, whatever the status', async () => {
    const { fetch } = stubFetch(errorResponse(400, 'not_a_kernel_code', 'nope'));
    const err = await client(fetch).request('/runs').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('not_a_kernel_code');
  });

  it('falls back to the status line when the error body is not JSON', async () => {
    const { fetch } = stubFetch(
      new Response('<html>gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const err = await client(fetch).request('/runs').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect((err as HttpError).code).toBeNull();
    expect((err as HttpError).message).toBe('Bad Gateway');
  });

  it('falls back to "HTTP <status>" when there is no status text either', async () => {
    const { fetch } = stubFetch(new Response('', { status: 418, statusText: '' }));
    const err = await client(fetch).request('/runs').catch((e: unknown) => e);
    expect((err as HttpError).message).toBe('HTTP 418');
  });

  it('reports a transport failure as HttpError(0) pointing at the daemon', async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await client(fetch).request('/health').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
    expect((err as HttpError).code).toBeNull();
    expect((err as HttpError).message).toContain(
      'http://daemon.test:4848/api/v1/health failed (fetch failed)',
    );
    expect((err as HttpError).message).toContain('is the worker daemon running?');
  });

  it("surfaces the caller's own abort instead of wrapping it", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new Error('aborted by caller');
    const { fetch } = stubFetch(() => {
      throw abortError;
    });

    const err = await client(fetch)
      .request('/runs', { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBe(abortError);
  });

  it('aborts the request once the per-request timeout elapses', async () => {
    // The stub never resolves on its own; only the internal timeout can end it.
    const fetchImpl = ((_input: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')));
      })) as unknown as typeof globalThis.fetch;

    const err = await client(fetchImpl)
      .request('/runs', { timeoutMs: 5 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
  });
});
