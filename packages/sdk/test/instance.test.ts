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
import { DEFAULT_NAMESPACE, KernelError, type WaitResult } from '@better-trigger/core';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/client';
import { betterTrigger, ResultTimeoutError } from '../src/instance';
import { task } from '../src/task';

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

/**
 * A fetch stub that holds each request open for EXACTLY its requested
 * `timeoutMs` slice, then answers non-terminal — the same hold-then-answer
 * contract the real route keeps, so a long wait consumes its whole slice of the
 * (fake) clock and the SDK's slicing math is observable hop by hop.
 */
function slicePollingNonTerminal(
  status: 'queued' | 'running' | 'waiting',
): typeof globalThis.fetch {
  return ((input: any, init: any) => {
    const timeoutMs = Number(new URL(String(input)).searchParams.get('timeoutMs'));
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        resolve(
          new Response(JSON.stringify({ status }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }, timeoutMs);
      init.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
    });
  }) as unknown as typeof globalThis.fetch;
}

/**
 * Dispatch each fetch call to the handler at that index (the last repeats) and
 * record the calls. Unlike scriptedFetch, the handler receives the real
 * (url, init) args — needed when the handler reads the URL (slice polling).
 */
function handledFetch(
  handlers: Array<(input: any, init: any) => Response | Promise<Response>>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = async (input: any, init: any) => {
    calls.push({ url: String(input), init: init ?? {} });
    const h = handlers[Math.min(i, handlers.length - 1)];
    i++;
    return h(input, init);
  };
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

/** The Symbol.for key instance.ts/registry.ts share (registry.ts's slot). */
const REGISTRY_KEY = Symbol.for('better-trigger.registry.v1');

function registrySlot(): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
}

/** Wipe the registry slot and re-import a fresh module copy — what a second
 *  copy of the package would see. Used by the registry-precedence tests. */
async function freshInstanceModule(): Promise<typeof import('../src/instance')> {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  vi.resetModules();
  return await import('../src/instance');
}

function restoreRegistrySlot(original: unknown): void {
  (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY] = original;
  vi.resetModules();
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

  it('aborts during the retry backoff sleep instead of waiting it out', async () => {
    vi.useFakeTimers();
    try {
      // Every hop answers 503 instantly, so the loop parks in the backoff
      // sleep — the abort must cut that sleep short, not land after it.
      const { fetch } = scriptedFetch([errorResponse(503, 'internal_error', 'boom')]);
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });
      const controller = new AbortController();
      const reason = new Error('caller stopped');

      const result = trigger.waitForResult('run_1', undefined, {
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      const errPromise = result.catch((e: unknown) => e);
      await flush(); // first 503 lands, the backoff sleep is armed
      controller.abort(reason);
      const err = await errPromise;

      // The caller's reason surfaces untouched (as on the in-flight path)...
      expect(err).toBe(reason);
      // ...and the backoff timer is cleared — nothing left to fire into a
      // settled wait.
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

describe('waitForResult — long-poll slicing (p2-36)', () => {
  it('slices a long wait into hops capped at MAX_LONGPOLL_MS with the remainder on the last hop', async () => {
    vi.useFakeTimers();
    try {
      // 60s budget, 25s cap → 25s / 25s / 10s. Each hop consumes its whole
      // slice of the fake clock before answering 'running'.
      const { fetch, calls } = handledFetch([slicePollingNonTerminal('running')]);
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

      const result = trigger.waitForResult('run_1', undefined, { timeoutMs: 60_000 });
      await flush();
      await vi.advanceTimersByTimeAsync(25_000); // hop 1 answers at t=25s
      await flush();
      await vi.advanceTimersByTimeAsync(25_000); // hop 2 answers at t=50s
      await flush();
      await vi.advanceTimersByTimeAsync(10_000); // hop 3 answers at t=60s → budget spent
      await expect(result).resolves.toEqual({ status: 'running' });

      const slices = calls.map(
        (c) => Number(new URL(c.url).searchParams.get('timeoutMs')),
      );
      expect(slices).toEqual([25_000, 25_000, 10_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a terminal result as soon as a hop sees it, without polling out the budget', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = handledFetch([
        slicePollingNonTerminal('running'), // hop 1: a full 25s of 'running'
        (_input: any, _init: any) => terminalResponse('completed', { done: true }), // hop 2: immediate terminal
      ]);
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

      const result = trigger.waitForResult('run_1', undefined, { timeoutMs: 120_000 });
      await flush();
      await vi.advanceTimersByTimeAsync(25_000); // hop 1 answers 'running'
      await flush();
      // Hop 2's terminal answer settles in microtasks — no more clock to advance.
      await expect(result).resolves.toEqual({ status: 'completed', output: { done: true } });
      expect(calls).toHaveLength(2); // stopped as soon as terminal
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends the budget on a retriable error, then takes one last timeoutMs=0 immediate read', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let first = true;
      // Hop 1: held open 300ms of fake time, then a 503 (the backoff sleep then
      // clamps to the remaining 100ms, landing exactly on the deadline). Hop 2:
      // slice===0, answered terminal — the "budget is spent" read can still win.
      const fetchImpl = ((input: any, init: any) => {
        calls.push(String(input));
        if (first) {
          first = false;
          return new Promise<Response>((resolve) => {
            const timer = setTimeout(
              () => resolve(errorResponse(503, 'waiter_abandoned', 'daemon shutting down')),
              300,
            );
            init.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
          });
        }
        return terminalResponse('completed', { recovered: true });
      }) as unknown as typeof globalThis.fetch;
      const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch: fetchImpl });

      const result = trigger.waitForResult('run_1', undefined, { timeoutMs: 400 });
      await flush();
      await vi.advanceTimersByTimeAsync(300); // the 503 lands at t=300ms
      await flush();
      await vi.advanceTimersByTimeAsync(100); // backoff sleep runs out → t=400ms
      await flush();
      await expect(result).resolves.toEqual({ status: 'completed', output: { recovered: true } });

      expect(calls).toHaveLength(2);
      // The final read asked for slice 0 — an immediate server-side check.
      expect(new URL(calls[1]!).searchParams.get('timeoutMs')).toBe('0');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waitForResult — namespace + pollMs propagation (p2-36)', () => {
  it('sends no query when polling with an undefined namespace', async () => {
    const { fetch, calls } = scriptedFetch([terminalResponse('completed', { ok: 1 })]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });
    await trigger.waitForResult('run_1', undefined, { timeoutMs: 30_000 });

    const url = new URL(calls[0].url);
    expect(url.searchParams.has('projectId')).toBe(false);
    expect(url.searchParams.has('env')).toBe(false);
  });

  it('sends the namespace and pollMs on every long-poll query', async () => {
    const { fetch, calls } = scriptedFetch([terminalResponse('completed', { ok: 1 })]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });
    await trigger.waitForResult(
      'run_1',
      { projectId: 'acme', env: 'staging' },
      { timeoutMs: 30_000, pollMs: 500 },
    );

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('projectId')).toBe('acme');
    expect(url.searchParams.get('env')).toBe('staging');
    expect(url.searchParams.get('pollMs')).toBe('500');
    // The slice is still capped at MAX_LONGPOLL_MS even with a namespace.
    expect(url.searchParams.get('timeoutMs')).toBe('25000');
  });

  it('scopes the run-id routes with nsQuery and omits it when absent', async () => {
    const { fetch, calls } = scriptedFetch([
      new Response(JSON.stringify({ id: 'run_1', status: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(null, { status: 204 }),
      new Response(JSON.stringify({ runId: 'run_3' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(JSON.stringify({ run: { id: 'run_4' }, steps: [], waits: [], logs: [], logsNextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

    await trigger.getRun('run_1', { projectId: 'acme', env: 'staging' });
    await trigger.cancelRun('run_2'); // no namespace → no query
    await trigger.retryRun('run_3', { projectId: 'p', env: 'dev' });
    await trigger.getRunDetail('run_4', undefined, { logsBefore: 100 });

    expect(calls[0].url).toBe('http://daemon.test:4848/api/v1/runs/run_1/record?projectId=acme&env=staging');
    expect(calls[1].url).toBe('http://daemon.test:4848/api/v1/runs/run_2/cancel');
    expect(calls[2].url).toBe('http://daemon.test:4848/api/v1/runs/run_3/retry?projectId=p&env=dev');
    expect(calls[3].url).toBe('http://daemon.test:4848/api/v1/runs/run_4?logsBefore=100');
  });

  it('derives the handle namespace from nsFromOptions, so result() polls the created scope', async () => {
    const { fetch, calls } = scriptedFetch([
      new Response(JSON.stringify({ runId: 'run_9', idempotent: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      terminalResponse('completed', { done: true }),
    ]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

    const handle = await trigger.trigger('hello', { n: 1 }, { projectId: 'acme', env: 'staging' });
    await handle.result();

    expect(new URL(calls[0].url).pathname).toBe('/api/v1/trigger');
    const pollUrl = new URL(calls[1].url);
    expect(pollUrl.searchParams.get('projectId')).toBe('acme');
    expect(pollUrl.searchParams.get('env')).toBe('staging');
  });

  it('defaults the handle namespace to default/prod when none was given', async () => {
    const { fetch, calls } = scriptedFetch([
      new Response(JSON.stringify({ runId: 'run_9', idempotent: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      terminalResponse('completed', { done: true }),
    ]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

    const handle = await trigger.trigger('hello', { n: 1 });
    await handle.result();

    const pollUrl = new URL(calls[1].url);
    expect(pollUrl.searchParams.get('projectId')).toBe(DEFAULT_NAMESPACE.projectId);
    expect(pollUrl.searchParams.get('env')).toBe(DEFAULT_NAMESPACE.env);
  });
});

describe('waitForResult — overloads (p1-05)', () => {
  it('accepts the two-arg (runId, opts) form the README documents', async () => {
    const { fetch, calls } = scriptedFetch([terminalResponse('completed', { ok: 1 })]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });
    await trigger.waitForResult('run_1', { timeoutMs: 300 });

    const url = new URL(calls[0].url);
    expect(url.searchParams.has('projectId')).toBe(false);
    expect(url.searchParams.has('env')).toBe(false);
    // The query carries the *slice* remaining (min(budget, MAX_LONGPOLL_MS)),
    // not the raw timeoutMs; it must be positive and no larger than the 300ms
    // budget, but the exact value races the clock across a ms boundary.
    const slice = Number(url.searchParams.get('timeoutMs'));
    expect(slice).toBeGreaterThan(0);
    expect(slice).toBeLessThanOrEqual(300);
  });

  it('accepts the three-arg (runId, namespace, opts) form and sends the namespace', async () => {
    const { fetch, calls } = scriptedFetch([terminalResponse('completed', { ok: 1 })]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });
    const result = await trigger.waitForResult(
      'run_1',
      { projectId: 'default', env: 'prod' },
      { timeoutMs: 300 },
    );

    expect(result).toEqual({ status: 'completed', output: { ok: 1 } });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('projectId')).toBe('default');
    expect(url.searchParams.get('env')).toBe('prod');
  });

  it('accepts the one-arg (runId) form', async () => {
    const { fetch, calls } = scriptedFetch([terminalResponse('completed', { ok: 1 })]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });
    await trigger.waitForResult('run_1');

    expect(calls).toHaveLength(1);
  });
});

describe('trigger() — concurrency-key derivation (p2-36)', () => {
  const created = () =>
    new Response(JSON.stringify({ runId: 'run_1', idempotent: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('derives the key from taskOrId.__definition.concurrency.key(payload)', async () => {
    const { fetch, calls } = scriptedFetch([created()]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });
    const handle = task({
      id: 'orders',
      concurrency: { key: (p: { userId: string }) => p.userId },
      run: (p: { userId: string }) => p,
    });

    await trigger.trigger(handle, { userId: 'u-1' });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.taskId).toBe('orders');
    expect(body.payload).toEqual({ userId: 'u-1' });
    expect(body.options).toEqual({ concurrencyKey: 'u-1' });
  });

  it('lets an explicit concurrencyKey option win over the derived key', async () => {
    const { fetch, calls } = scriptedFetch([created()]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });
    const handle = task({
      id: 'orders',
      concurrency: { key: (p: { userId: string }) => p.userId },
      run: (p: { userId: string }) => p,
    });

    await trigger.trigger(handle, { userId: 'u-1' }, { concurrencyKey: 'explicit' });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.options).toEqual({ concurrencyKey: 'explicit' });
  });

  it('does not derive a key for a string task id (no __definition)', async () => {
    const { fetch, calls } = scriptedFetch([created()]);
    const trigger = betterTrigger({ url: 'http://daemon.test:4848', fetch });

    await trigger.trigger('orders', { n: 1 });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.taskId).toBe('orders');
    expect(body.options).toBeUndefined();
  });
});

describe('makeRunHandle — resolver precedence (p2-36)', () => {
  it('prefers the handle instance over an installed resolver and the default instance', async () => {
    const original = registrySlot();
    try {
      const { makeRunHandle, setResultResolver, betterTrigger } = await freshInstanceModule();
      const resolver = { waitForResult: vi.fn() };
      setResultResolver(resolver);
      const fetchA = scriptedFetch([terminalResponse('completed', { a: 1 })]);
      const fetchB = scriptedFetch([terminalResponse('completed', { b: 2 })]);
      betterTrigger({ url: 'http://a.test', fetch: fetchA.fetch }); // becomes default
      const instB = betterTrigger({ url: 'http://b.test', fetch: fetchB.fetch });

      const handle = makeRunHandle('run_1', instB);
      await handle.result();

      expect(resolver.waitForResult).not.toHaveBeenCalled();
      expect(fetchB.calls).toHaveLength(1);
      expect(fetchA.calls).toHaveLength(0); // default instance not consulted
    } finally {
      restoreRegistrySlot(original);
    }
  });

  it('prefers the installed resultResolver over the default instance', async () => {
    const original = registrySlot();
    try {
      const { makeRunHandle, setResultResolver, betterTrigger } = await freshInstanceModule();
      const resolver = {
        waitForResult: vi.fn(async (): Promise<WaitResult> => ({ status: 'completed' })),
      };
      setResultResolver(resolver);
      const fetchA = scriptedFetch([terminalResponse('completed', { a: 1 })]);
      betterTrigger({ url: 'http://a.test', fetch: fetchA.fetch }); // default

      const handle = makeRunHandle('run_1'); // no instance arg
      await handle.result();

      expect(resolver.waitForResult).toHaveBeenCalledWith('run_1', undefined, undefined);
      expect(fetchA.calls).toHaveLength(0);
    } finally {
      restoreRegistrySlot(original);
    }
  });

  it('falls back to the default instance when neither an instance nor a resolver is set', async () => {
    const original = registrySlot();
    try {
      const { makeRunHandle, betterTrigger } = await freshInstanceModule();
      const fetchA = scriptedFetch([terminalResponse('completed', { a: 1 })]);
      betterTrigger({ url: 'http://a.test', fetch: fetchA.fetch }); // default

      const handle = makeRunHandle('run_1'); // no instance, no resolver
      await handle.result();

      expect(fetchA.calls).toHaveLength(1);
    } finally {
      restoreRegistrySlot(original);
    }
  });
});

describe('registry.defaultInstance — first-wins, setDefault override, requireDefaultInstance (p2-36)', () => {
  it('keeps the FIRST instance as the default until setDefault overrides it', async () => {
    const original = registrySlot();
    try {
      const { requireDefaultInstance, betterTrigger } = await freshInstanceModule();
      const fetch1 = scriptedFetch([terminalResponse('completed', { i: 1 })]);
      const fetch2 = scriptedFetch([terminalResponse('completed', { i: 2 })]);
      const inst1 = betterTrigger({ url: 'http://one.test', fetch: fetch1.fetch });
      const inst2 = betterTrigger({ url: 'http://two.test', fetch: fetch2.fetch });

      expect(requireDefaultInstance()).toBe(inst1); // ??= first-wins
      inst2.setDefault();
      expect(requireDefaultInstance()).toBe(inst2); // explicit override wins
    } finally {
      restoreRegistrySlot(original);
    }
  });

  it('requireDefaultInstance() throws a clear error when no instance was ever created', async () => {
    const original = registrySlot();
    try {
      const { requireDefaultInstance } = await freshInstanceModule();
      expect(() => requireDefaultInstance()).toThrow(/betterTrigger instance registered/);
    } finally {
      restoreRegistrySlot(original);
    }
  });
});
