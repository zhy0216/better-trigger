/* =============================================================================
   @better-trigger/kernel — waitForResult options and lifecycle contract.

   The HTTP route clamps pollMs to [50, 5000] with onInvalid:'clamp', but
   waitForResult is also the embedded-host path and a public Kernel method —
   a `pollMs: 0` there turns sleep() into a zero-delay timer and the whole
   timeout window into a tight SELECT loop against the database. Same family
   as detailLimit/logsBefore: garbage is refused with bad_request before a
   single query runs, while the normal long-poll behaviour is untouched.

   No Postgres: stub/deferred queries and fake clocks cover the deadline,
   cancellation, late query outcomes, timer bounds and cleanup deterministically.
   ============================================================================= */
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError, ResultTimeoutError, type WaitForResultOptions } from '@better-trigger/core';
import { waitForResult } from '../src/runs';

/** A pool whose every query proves validation let the call through. */
const sentinel = new Error('query() reached — validation did not refuse');
const refusingPool = {
  query: async () => {
    throw sentinel;
  },
} as unknown as Pool;

const wait = (pool: Pool, opts: { pollMs?: number; timeoutMs?: number } = {}) =>
  waitForResult(pool, 'run_1', DEFAULT_NAMESPACE, opts);

describe('waitForResult pollMs validation', () => {
  it('refuses 0 / negative / fractional below 1 / NaN / Infinity before querying', async () => {
    for (const pollMs of [0, -1, 0.5, NaN, Infinity]) {
      await expect(wait(refusingPool, { pollMs })).rejects.toBeInstanceOf(KernelError);
      await wait(refusingPool, { pollMs }).catch((err: KernelError) => {
        expect(err.code).toBe('bad_request');
        expect(err.message).toMatch(/pollMs/);
      });
    }
  });

  it('keeps the default and explicit legal poll intervals', async () => {
    const queries: unknown[][] = [];
    const donePool = {
      query: async (_sql: string, params: unknown[] = []) => {
        queries.push(params);
        return { rows: [{ status: 'completed', output: { ok: 1 }, error: null }] };
      },
    } as unknown as Pool;

    // Default (no opts) → one query, terminal result on the spot.
    await expect(wait(donePool)).resolves.toEqual({
      status: 'completed',
      output: { ok: 1 },
      error: undefined,
    });
    // The historical floor of the route clamp still passes.
    await expect(wait(donePool, { pollMs: 50 })).resolves.toMatchObject({ status: 'completed' });
    // 1 is the accepted minimum (the old loop would have hammered the DB).
    await expect(wait(donePool, { pollMs: 1 })).resolves.toMatchObject({ status: 'completed' });
  });
});

describe('waitForResult long-poll behaviour (unchanged)', () => {
  it('returns the latest non-terminal status when the timeout window closes', async () => {
    let polls = 0;
    const pool = {
      query: async () => {
        polls += 1;
        return { rows: [{ status: 'running', output: null, error: null }] };
      },
    } as unknown as Pool;

    const before = Date.now();
    const res = await waitForResult(pool, 'run_1', DEFAULT_NAMESPACE, {
      timeoutMs: 60,
      pollMs: 15,
    });
    const elapsed = Date.now() - before;

    expect(res).toEqual({ status: 'running' });
    // A real polling loop: more than one read, and no tighter than pollMs
    // (a 60ms window at 15ms is ≥ 2 polls — proof the sleep still sleeps).
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });
});

describe('waitForResult options and lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fixture() {
    const query = vi.fn(async () => ({
      rows: [{ status: 'running', output: null as unknown, error: null as unknown }],
    }));
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const run = (opts: WaitForResultOptions = {}) => waitForResult(
      { query } as unknown as Pool, 'run_1', DEFAULT_NAMESPACE,
      { signal: controller.signal, ...opts },
    );
    const cleaned = () => {
      expect(vi.getTimerCount()).toBe(0);
      expect(removed.mock.calls.map((call) => call[1])).toEqual(
        added.mock.calls.map((call) => call[1]),
      );
    };
    return { query, controller, run, cleaned };
  }

  it.each([NaN, -1, -Infinity, '10', null, false, {}, 1n])(
    'rejects invalid timeoutMs %s before querying', async (value) => {
      const { query, run, cleaned } = fixture();
      await expect(run({ timeoutMs: value as number })).rejects.toMatchObject({
        code: 'bad_request', message: expect.stringContaining('timeoutMs'),
      });
      expect(query).not.toHaveBeenCalled();
      cleaned();
    },
  );

  it.each([2_147_483_648, -Infinity, '10', null, false, {}])(
    'rejects unsafe pollMs %s before querying', async (value) => {
      const { query, run, cleaned } = fixture();
      await expect(run({ pollMs: value as number })).rejects.toMatchObject({ code: 'bad_request' });
      expect(query).not.toHaveBeenCalled();
      cleaned();
    },
  );

  it.each([undefined, new Error('caller stopped'), 'stop', null])(
    'pre-abort preserves reason %s and issues zero queries', async (reason) => {
      const { query, controller, run, cleaned } = fixture();
      controller.abort(reason);
      await expect(run({ timeoutMs: 0, throwOnTimeout: true })).rejects.toBe(controller.signal.reason);
      expect(query).not.toHaveBeenCalled();
      cleaned();
    },
  );

  it.each([false, true])('zero budget reads once (throwOnTimeout=%s)', async (throwOnTimeout) => {
    const { query, run, cleaned } = fixture();
    await expect(run({ timeoutMs: 0, throwOnTimeout })).resolves.toEqual({ status: 'running' });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('SELECT status'),
      ['run_1', DEFAULT_NAMESPACE.projectId, DEFAULT_NAMESPACE.env]);
    cleaned();
  });

  it.each(['completed', 'failed', 'canceled'])('keeps the %s terminal result', async (status) => {
    const { query, run, cleaned } = fixture();
    const row = { status, output: { ok: 1 }, error: { name: 'Error', message: 'failure' } };
    query.mockResolvedValue({ rows: [row] });
    await expect(run({ timeoutMs: 0, throwOnTimeout: true })).resolves.toEqual(row);
    cleaned();
  });

  it('preserves not_found and query errors and cleans up', async () => {
    const { query, run, cleaned } = fixture();
    query.mockResolvedValueOnce({ rows: [] });
    await expect(run()).rejects.toMatchObject({ code: 'not_found' });
    const failure = new Error('database offline');
    query.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
    cleaned();
  });

  it.each([false, true])('spends the final partial poll budget (throwOnTimeout=%s)', async (throwOnTimeout) => {
    const { query, run, cleaned } = fixture();
    query.mockResolvedValueOnce({ rows: [{ status: 'queued', output: null, error: null }] });
    query.mockResolvedValue({ rows: [{ status: 'waiting', output: 'stale', error: 'stale' }] });
    const settled = vi.fn();
    void run({ timeoutMs: 65, pollMs: 25, throwOnTimeout }).then(settled, settled);
    await vi.advanceTimersByTimeAsync(64);
    expect(settled).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(throwOnTimeout
      ? expect.any(ResultTimeoutError) : { status: 'waiting' });
    if (throwOnTimeout) {
      expect(settled.mock.calls[0]![0]).toMatchObject({
        name: 'ResultTimeoutError', status: 'waiting',
        message: 'run run_1 did not reach a terminal state within 65ms (status waiting)',
      });
    }
    cleaned();
  });

  it('waits the full budget when pollMs exceeds it', async () => {
    const { query, run, cleaned } = fixture();
    const settled = vi.fn();
    void run({ timeoutMs: 35, pollMs: 250 }).then(settled);
    await vi.advanceTimersByTimeAsync(34);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith({ status: 'running' });
    expect(query).toHaveBeenCalledTimes(1);
    cleaned();
  });

  it('observes a terminal state during the last polling interval', async () => {
    const { query, run, cleaned } = fixture();
    const result = run({ timeoutMs: 65, pollMs: 25, throwOnTimeout: true });
    await vi.advanceTimersByTimeAsync(40);
    query.mockResolvedValue({ rows: [{ status: 'completed', output: 'done', error: null }] });
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ status: 'completed', output: 'done' });
    cleaned();
  });

  it('accepts fractional budgets without returning early', async () => {
    const { run, cleaned } = fixture();
    const settled = vi.fn();
    void run({ timeoutMs: 2.5, pollMs: 1.5 }).then(settled);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith({ status: 'running' });
    cleaned();
  });

  it.each([Infinity, 2_147_483_648])('keeps a legal long timeout %s and timer-safe polls', async (timeoutMs) => {
    const { query, run, controller, cleaned } = fixture();
    const settled = vi.fn();
    void run({ timeoutMs, pollMs: 2_147_483_647 }).then(settled, settled);
    await vi.advanceTimersByTimeAsync(100);
    expect(query).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith(controller.signal.reason);
    cleaned();
  });

  it('re-arms long finite deadlines in timer-safe chunks', async () => {
    const { run, cleaned } = fixture();
    const settled = vi.fn();
    void run({ timeoutMs: 2_147_483_657, pollMs: 2_147_483_647 }).then(settled);
    await vi.advanceTimersByTimeAsync(2_147_483_656);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith({ status: 'running' });
    cleaned();
  });

  it('Infinity still polls through to a terminal state', async () => {
    const { query, run, cleaned } = fixture();
    const result = run({ timeoutMs: Infinity, pollMs: 25 });
    await vi.advanceTimersByTimeAsync(0);
    query.mockResolvedValue({ rows: [{ status: 'completed', output: 'done', error: null }] });
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toMatchObject({ status: 'completed', output: 'done' });
    cleaned();
  });

  it('aborts a sleeping wait immediately without another poll', async () => {
    const { query, run, controller, cleaned } = fixture();
    const result = run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('stop sleeping'));
    expect(await result).toBe(controller.signal.reason);
    cleaned();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('aborts an in-flight initial read; consumes late %s', async (outcome) => {
    const { query, run, controller, cleaned } = fixture();
    const pending = deferred<Awaited<ReturnType<typeof query>>>();
    query.mockReturnValueOnce(pending.promise);
    const settled = vi.fn();
    const result = run().then(settled, settled);
    controller.abort(new Error('stop reading'));
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith(controller.signal.reason);
    cleaned();
    if (outcome === 'resolve') pending.resolve({ rows: [{ status: 'running', output: null, error: null }] });
    else pending.reject(new Error('late SQL rejection'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    cleaned();
  });

  it.each(['abort', 'timeout'] as const)('settles on %s during a later hung query', async (winner) => {
    const { query, run, controller, cleaned } = fixture();
    const pending = deferred<Awaited<ReturnType<typeof query>>>();
    const settled = vi.fn();
    void run({ timeoutMs: 60, pollMs: 25, throwOnTimeout: true }).then(settled, settled);
    await vi.advanceTimersByTimeAsync(0);
    query.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(25);
    expect(query).toHaveBeenCalledTimes(2);
    if (winner === 'abort') controller.abort();
    await vi.advanceTimersByTimeAsync(35);
    expect(settled).toHaveBeenCalledExactlyOnceWith(winner === 'abort'
      ? controller.signal.reason : expect.any(ResultTimeoutError));
    if (winner === 'timeout') expect(settled.mock.calls[0]![0].status).toBe('running');
    cleaned();
    pending.reject(new Error('late database failure'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledTimes(1);
    cleaned();
  });

  it('counts initial read latency in the budget without inventing a status', async () => {
    const { query, run, cleaned } = fixture();
    const pending = deferred<Awaited<ReturnType<typeof query>>>();
    query.mockReturnValueOnce(pending.promise);
    const settled = vi.fn();
    void run({ timeoutMs: 50, pollMs: 25 }).then(settled);
    await vi.advanceTimersByTimeAsync(60);
    expect(settled).not.toHaveBeenCalled();
    pending.resolve({ rows: [{ status: 'queued', output: null, error: null }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith({ status: 'queued' });
    expect(query).toHaveBeenCalledTimes(1);
    cleaned();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
