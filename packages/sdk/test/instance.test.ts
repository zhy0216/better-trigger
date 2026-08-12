/* =============================================================================
   better-trigger — waitForResult retry unit tests.

   waitForResult is the SDK's only retrying caller: a transient failure (5xx,
   or a transport failure that never produced a response — HttpError status 0)
   is retried with jittered exponential backoff inside the caller's timeout
   budget, so an in-flight result() survives a daemon redeploy (the server
   deliberately answers abandoned waiters with a 5xx meant for the SDK to retry
   against another daemon). Deterministic failures — 4xx, KernelErrors — fail
   immediately. No daemon, no Postgres — `fetch` is injected and the clock is
   faked.
   ============================================================================= */
import { KernelError } from '@better-trigger/core';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/client';
import { betterTrigger } from '../src/instance';

/** A fetch stub answering calls from a scripted list; the last entry repeats. */
function scriptedFetch(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = async (input: any, init: any) => {
    calls.push({ url: String(input), init: init ?? {} });
    const res = responses[Math.min(i, responses.length - 1)];
    i++;
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

function terminalResponse(
  status: 'completed' | 'failed' | 'canceled',
  output: unknown,
): Response {
  return new Response(JSON.stringify({ status, output }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Pump the microtask queue so an in-flight request settles (and, on a 5xx,
 *  reaches its retry sleep) before the test advances the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('waitForResult — retryable failures', () => {
  it('retries a transient 503 and resolves once the daemon answers', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = scriptedFetch([
        errorResponse(503, 'waiter_abandoned', 'daemon shutting down'),
        terminalResponse('completed', { delivered: true }),
      ]);
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch, timeoutMs: 30_000 });

      const result = trigger.waitForResult('run_1', undefined, { timeoutMs: 5_000 });
      await flush(); // first 503 lands, retry sleep armed
      await vi.advanceTimersByTimeAsync(1_000); // let the backoff elapse
      await expect(result).resolves.toEqual({ status: 'completed', output: { delivered: true } });

      expect(calls.length).toBeGreaterThanOrEqual(2); // a retry actually happened
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws the LAST HttpError when 5xx persists to the deadline', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = scriptedFetch([
        errorResponse(503, 'internal_error', 'unhandled error'),
      ]);
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

      const result = trigger.waitForResult('run_1', undefined, { timeoutMs: 300 });
      // Attach the handler up front: the rejection lands during the advance.
      const errPromise = result.catch((e: unknown) => e);
      await flush();
      await vi.advanceTimersByTimeAsync(1_000); // exhaust the 300ms budget
      const err = await errPromise;

      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(503); // the last one, not a fabricated status
      expect(calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waitForResult — non-retryable failures', () => {
  it('fails immediately on a KernelError (not_found) without retrying', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = scriptedFetch([errorResponse(404, 'not_found', 'no such run')]);
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

      const err = await trigger
        .waitForResult('run_1', undefined, { timeoutMs: 5_000 })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe('not_found');
      expect(calls).toHaveLength(1);

      // Far past any would-be backoff: nothing retried, no timer lingers.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waitForResult — budget discipline', () => {
  it('never lets backoff push past the timeout budget', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = scriptedFetch([
        errorResponse(503, 'internal_error', 'unhandled error'),
      ]);
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });
      const start = Date.now();

      const result = trigger.waitForResult('run_1', undefined, { timeoutMs: 400 });
      // Attach the handler up front: the rejection lands during the advance.
      const errPromise = result.catch((e: unknown) => e);
      await flush();
      await vi.advanceTimersByTimeAsync(400); // exactly the budget
      const err = await errPromise;

      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(503); // no fabricated terminal
      expect(Date.now() - start).toBeLessThanOrEqual(400);
      expect(calls.length).toBeGreaterThan(1); // it retried inside the budget
      expect(vi.getTimerCount()).toBe(0); // nothing left scheduled
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('batchTrigger — namespace options in the request body (p1-15)', () => {
  it('sends the batch-level env/projectId as the body options', async () => {
    const { fetch, calls } = scriptedFetch([
      new Response(JSON.stringify({ runIds: ['run_1'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

    const handles = await trigger.batchTrigger(
      [{ taskId: 'hello', payload: { n: 1 } }],
      { env: 'staging', projectId: 'acme' },
    );

    expect(handles.map((h) => h.id)).toEqual(['run_1']);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toContain('/api/v1/batch-trigger');
    // Exactly what apps/worker's routes/trigger.ts reads for the batch.
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{ taskId: 'hello', payload: { n: 1 } }],
      options: { env: 'staging', projectId: 'acme' },
    });
  });
});
