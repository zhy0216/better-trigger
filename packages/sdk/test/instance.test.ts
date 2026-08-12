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
import { betterTrigger, ResultTimeoutError } from '../src/instance';

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

/**
 * A fetch stub that emulates the server's long-poll: each request is held open
 * `delayMs` of (fake) time, then answered with the given non-terminal status.
 * This mirrors the real route (hold until terminal or the request's slice) so
 * the client's retry loop parks on a real timer instead of spinning microtasks.
 */
function longPollingNonTerminal(
  status: 'queued' | 'running' | 'waiting',
  delayMs: number,
): typeof globalThis.fetch {
  return ((_input: any, init: any) =>
    new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        resolve(
          new Response(JSON.stringify({ status }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }, delayMs);
      init.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
    })) as unknown as typeof globalThis.fetch;
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

describe('waitForResult — throwOnTimeout (p2-23)', () => {
  it('throws ResultTimeoutError with the latest non-terminal status when the budget runs out', async () => {
    vi.useFakeTimers();
    try {
      const trigger = betterTrigger({
        url: 'http://daemon.test:4848',
        fetch: longPollingNonTerminal('running', 50),
      });

      const result = trigger.waitForResult('run_1', undefined, {
        timeoutMs: 300,
        throwOnTimeout: true,
      });
      // Attach the handler up front: the rejection lands during the advance.
      const errPromise = result.catch((e: unknown) => e);
      await flush();
      await vi.advanceTimersByTimeAsync(400); // exhaust the 300ms budget
      const err = await errPromise;

      expect(err).toBeInstanceOf(ResultTimeoutError);
      const rte = err as ResultTimeoutError;
      expect(rte.status).toBe('running'); // the latest non-terminal status
      expect(rte.message).toMatch(/run run_1 did not reach a terminal state within 300ms/);
      expect(rte.message).toMatch(/\(status running\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without throwOnTimeout resolves with the latest non-terminal status (existing behavior)', async () => {
    vi.useFakeTimers();
    try {
      const trigger = betterTrigger({
        url: 'http://daemon.test:4848',
        fetch: longPollingNonTerminal('running', 50),
      });

      const result = trigger.waitForResult('run_1', undefined, { timeoutMs: 300 });
      await flush();
      await vi.advanceTimersByTimeAsync(400);
      await expect(result).resolves.toEqual({ status: 'running' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws ResultTimeoutError on the retry-loop error path when throwOnTimeout is set', async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = scriptedFetch([
        errorResponse(503, 'internal_error', 'unhandled error'),
      ]);
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

      const result = trigger.waitForResult('run_1', undefined, {
        timeoutMs: 300,
        throwOnTimeout: true,
      });
      const errPromise = result.catch((e: unknown) => e);
      await flush(); // first 503 lands, retry sleep armed
      await vi.advanceTimersByTimeAsync(1_000); // exhaust the 300ms budget
      const err = await errPromise;

      expect(err).toBeInstanceOf(ResultTimeoutError);
      // No poll ever succeeded, so no status was observed.
      expect((err as ResultTimeoutError).status).toBeUndefined();
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

describe('waitForResult — caller signal (p1-17)', () => {
  it('aborts the in-flight long-poll when the caller signal fires', async () => {
    vi.useFakeTimers();
    try {
      // The stub never settles on its own — only the caller's abort can end
      // the long-poll (a real fetch rejects with the signal's reason).
      const fetchImpl = ((_input: any, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        })) as unknown as typeof globalThis.fetch;
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch: fetchImpl });
      const controller = new AbortController();

      const result = trigger.waitForResult('run_1', undefined, {
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      const errPromise = result.catch((e: unknown) => e);
      await flush(); // the long-poll is in flight
      controller.abort();
      const err = await errPromise;

      // Abort errors are not retriable, so the poll fails immediately instead
      // of looping until the timeout budget — and no retry/backoff timer lingers.
      expect((err as Error)?.name).toBe('AbortError');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RunHandle.result() — no instance registered (p1-17)', () => {
  const REGISTRY_KEY = Symbol.for('better-trigger.registry.v1');

  it('returns a REJECTED promise (not a sync throw) with no resolver', async () => {
    // betterTrigger() calls above have stamped a defaultInstance on the shared
    // registry; wipe the slot and re-import so this handle sees NO resolver
    // (no instance, no installed resultResolver, no default).
    const original = (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
    try {
      delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
      vi.resetModules();
      const { makeRunHandle } = await import('../src/instance');
      const handle = makeRunHandle('run_1', undefined);

      // Async-consistent: calling result() returns a promise, never throws in
      // place — so `await handle.result().catch(...)` always works.
      const result = handle.result();
      expect(result).toBeInstanceOf(Promise);

      const err = await result.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('no betterTrigger instance registered');
    } finally {
      (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY] = original;
      vi.resetModules();
    }
  });
});
