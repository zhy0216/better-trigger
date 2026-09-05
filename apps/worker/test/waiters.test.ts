/* =============================================================================
   @better-trigger/worker — in-process waiter registry (PF2,
   todos/02-performance.md) and the claim-wake primitives.

   The registry replaces N independent kernel waitForResult poll loops with one
   shared structure: N waiters share a single 1s sweep (`WHERE id = ANY(...)`)
   plus terminal notifications, instead of ~4 SELECT/s per waiter. Its
   correctness contract mirrors kernel.waitForResult exactly:

     - run already terminal at register() → resolved immediately (this is also
        the race guard against a notification that fired before the waiter);
     - terminal notification (registry.resolve) → settled with output/error;
     - deadline passed → settled with the latest non-terminal status;
     - run vanished → rejected not_found;
     - the client disconnected (signal aborted, p1-14) while pending → the
        entry is freed at once and the promise rejects with
        ResultWaitAbortedError (name 'AbortError'); an abort that lands before
        registration never even reads the DB, and a late abort after settlement
        is a no-op. The route maps it to a 499.

   No Postgres: the registry takes a Pool, so a fake pool that answers the two
   query shapes (single-run read, batch ANY read) is enough.
   ============================================================================= */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError, ResultTimeoutError as CoreResultTimeoutError } from '@better-trigger/core';
import { ResultTimeoutError } from 'better-trigger';
import type { Kernel } from '@better-trigger/kernel';
import { createApp } from '../src/app';
import { createNotifyCounters } from '../src/observability';
import { createWakeSignal, sleepWithWake } from '../src/notify';
import {
  createWaiterRegistry,
  ResultWaitAbortedError,
  WaiterRegistryStoppedError,
  type WaiterRegistry,
} from '../src/waiters';

interface FakeRun {
  id: string;
  status: string;
  output?: unknown;
  error?: unknown;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake pool: holds the runs table in memory, counts reads on `runs`. */
function fakePool() {
  const runs = new Map<string, FakeRun>();
  let selects = 0;
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      if (/FROM runs/.test(text)) selects += 1;
      if (/WHERE id = \$1/.test(text)) {
        const row = runs.get(String(params?.[0]));
        return {
          rows: row
            ? [{ status: row.status, output: row.output ?? null, error: row.error ?? null }]
            : [],
        };
      }
      if (/WHERE id = ANY\(\$1::text\[\]\)/.test(text)) {
        const ids = params?.[0] as string[];
        return {
          rows: ids
            .map((id) => runs.get(id))
            .filter((r): r is FakeRun => r !== undefined)
            .map((r) => ({
              id: r.id,
              status: r.status,
              output: r.output ?? null,
              error: r.error ?? null,
            })),
        };
      }
      return { rows: [] };
    },
  };
  return {
    pool: pool as Parameters<typeof createWaiterRegistry>[0]['pool'],
    runs,
    selects: () => selects,
  };
}

function registry(pollMs = 20): { reg: WaiterRegistry; runs: Map<string, FakeRun>; selects: () => number } {
  const f = fakePool();
  const reg = createWaiterRegistry({ pool: f.pool, counters: createNotifyCounters(), pollMs });
  return { reg, runs: f.runs, selects: f.selects };
}

const NS = DEFAULT_NAMESPACE;

describe('waiter registry', () => {
  it('resolves immediately when the run is already terminal', async () => {
    const { reg, runs } = registry();
    runs.set('run_done', { id: 'run_done', status: 'completed', output: { ok: 1 } });
    const res = await reg.register('run_done', NS, { timeoutMs: 5_000 });
    expect(res).toEqual({ status: 'completed', output: { ok: 1 }, error: undefined });
    reg.stop();
  });

  it('rejects not_found when the run does not exist', async () => {
    const { reg } = registry();
    await expect(reg.register('run_ghost', NS, { timeoutMs: 5_000 })).rejects.toThrow(KernelError);
    reg.stop();
  });

  it('a terminal notification settles every waiter of that run with output/error', async () => {
    const { reg, runs, selects } = registry();
    runs.set('run_a', { id: 'run_a', status: 'running' });
    const pa = reg.register('run_a', NS, { timeoutMs: 5_000 });
    const pb = reg.register('run_a', NS, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 5)); // let both registrations land
    expect(reg.pending()).toBe(2);
    // Between registration and the notification: no sweep may resolve them yet.
    expect(selects()).toBe(2); // two initial reads only

    runs.set('run_a', { id: 'run_a', status: 'failed', error: { message: 'boom' } });
    await reg.resolve('run_a');
    const [a, b] = await Promise.all([pa, pb]);
    expect(a).toEqual({ status: 'failed', error: { message: 'boom' }, output: undefined });
    expect(b).toEqual(a);
    expect(reg.pending()).toBe(0);
    // One batched sweep would still not have run: N waiters, N+1 reads total.
    expect(selects()).toBe(3);
    reg.stop();
  });

  it('a stale terminal notification (run still non-terminal) settles nothing', async () => {
    const { reg, runs } = registry();
    runs.set('run_s', { id: 'run_s', status: 'running' });
    const p = reg.register('run_s', NS, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 5)); // let the registration land
    await reg.resolve('run_s'); // row still running → stale
    expect(reg.pending()).toBe(1);
    runs.set('run_s', { id: 'run_s', status: 'completed', output: 42 });
    const res = await p; // the sweep picks it up
    expect(res.status).toBe('completed');
    reg.stop();
  });

  it('the shared poller batches N waiters into ONE query and settles them', async () => {
    const { reg, runs, selects } = registry();
    runs.set('run_x', { id: 'run_x', status: 'running' });
    const waiters = Array.from({ length: 5 }, () => reg.register('run_x', NS, { timeoutMs: 5_000 }));
    const before = selects();
    await new Promise((r) => setTimeout(r, 60)); // let ≥2 sweeps run
    expect(selects() - before).toBeLessThanOrEqual(4); // ~1 query per sweep, not 5
    runs.set('run_x', { id: 'run_x', status: 'completed', output: 'done' });
    const results = await Promise.all(waiters);
    for (const r of results) expect(r.status).toBe('completed');
    reg.stop();
  });

  // F6: `pollMs` is deprecated/inert on the daemon path — the shared sweep is
  // the registry's own fixed interval, never a per-request knob. Two waiters
  // registered with wildly different opts.pollMs values must still share the
  // registry-level sweep: the fast value does not speed it into per-waiter
  // polling, the slow value does not stall it.
  it('opts.pollMs changes neither the sweep cadence nor the query count', async () => {
    const { reg, runs, selects } = registry(); // registry sweep every 20ms
    runs.set('run_p1', { id: 'run_p1', status: 'running' });
    const p1 = reg.register('run_p1', NS, { timeoutMs: 5_000, pollMs: 50 });
    const p2 = reg.register('run_p1', NS, { timeoutMs: 5_000, pollMs: 5_000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(selects()).toBe(2); // two initial reads only
    await new Promise((r) => setTimeout(r, 60));
    const delta = selects() - 2;
    expect(delta).toBeGreaterThanOrEqual(1); // the 5000 waiter did not stall the sweep
    expect(delta).toBeLessThanOrEqual(4); // the 50 waiter did not multiply queries (≈3 batched sweeps)
    runs.set('run_p1', { id: 'run_p1', status: 'completed', output: 'ok' });
    const [r1, r2] = await Promise.all([p1, p2]); // one sweep settles both
    expect(r1.status).toBe('completed');
    expect(r2.status).toBe('completed');
    reg.stop();
  });

  // p2-18 C4: sweep had no re-entrancy guard — a sweep slower than pollMs
  // (degraded database) kept launching overlapping batch reads. isPending
  // already prevented double-settling, but the redundant concurrent queries
  // did not match the single-flight shape of every other poll in the repo
  // (orchestrator loops, metrics gauge). The guard makes one sweep at most
  // in flight; skipped ticks are not lost, the next one covers the backlog.
  it('does not overlap sweeps when the query outlasts the interval', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let sweeps = 0;
    const state = { status: 'running', output: null as unknown };
    const pool = {
      query: async (text: string) => {
        if (/WHERE id = ANY/.test(text)) {
          sweeps += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 80)); // ≫ pollMs
          inFlight -= 1;
          return {
            rows: [{ id: 'run_r', status: state.status, output: state.output, error: null }],
          };
        }
        // The register() initial read — keep the waiter pending.
        return { rows: [{ status: 'running', output: null, error: null }] };
      },
    } as unknown as Parameters<typeof createWaiterRegistry>[0]['pool'];

    const reg = createWaiterRegistry({ pool, counters: createNotifyCounters(), pollMs: 10 });
    const p = reg.register('run_r', NS, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 250)); // ≥ 8 tick windows, ~3 slow sweeps
    expect(sweeps).toBeGreaterThan(0);
    expect(maxInFlight).toBe(1);
    // Without the guard ~25 overlapping sweeps would have fired in this
    // window; with it, at most one per actual sweep duration plus slack.
    expect(sweeps).toBeLessThanOrEqual(8);

    // The sweep still settles the waiter once the run goes terminal.
    state.status = 'completed';
    state.output = 'late';
    const res = await p;
    expect(res.status).toBe('completed');
    reg.stop();
  });

  it('times out with the latest non-terminal status, matching waitForResult', async () => {
    const { reg, runs } = registry();
    runs.set('run_t', { id: 'run_t', status: 'running' });
    const res = await reg.register('run_t', NS, { timeoutMs: 40 });
    expect(res).toEqual({ status: 'running' });
    reg.stop();
  });

  it('throwOnTimeout: true rejects with ResultTimeoutError instead of resolving the status', async () => {
    const { reg, runs } = registry();
    runs.set('run_to', { id: 'run_to', status: 'running' });
    const err = await reg
      .register('run_to', NS, { timeoutMs: 40, throwOnTimeout: true })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ResultTimeoutError);
    expect(err).toBeInstanceOf(CoreResultTimeoutError);
    expect(ResultTimeoutError).toBe(CoreResultTimeoutError);
    expect((err as ResultTimeoutError).status).toBe('running');
    expect((err as Error).message).toContain('run_to');
    reg.stop();
  });

  it('a run that vanishes after registration rejects not_found', async () => {
    const { reg, runs } = registry();
    runs.set('run_v', { id: 'run_v', status: 'running' });
    const p = reg.register('run_v', NS, { timeoutMs: 5_000 });
    runs.delete('run_v'); // pruned
    await expect(p).rejects.toThrow(KernelError);
    reg.stop();
  });

  it('stop() settles every pending waiter and the poller stops querying', async () => {
    const { reg, runs, selects } = registry();
    runs.set('run_z', { id: 'run_z', status: 'running' });
    const p = reg.register('run_z', NS, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 5)); // let the registration land
    expect(reg.pending()).toBe(1);

    reg.stop();
    // The pending waiter must not hang: it is rejected with the shutdown error
    // — never resolved with a fabricated status.
    await expect(p).rejects.toThrow('daemon shutting down');
    expect(reg.pending()).toBe(0);

    // And the poll timer must be dead: no sweep queries after stop().
    const before = selects();
    await new Promise((r) => setTimeout(r, 70)); // ~3 poll intervals
    expect(selects()).toBe(before);
    reg.stop(); // idempotent
  });

  it('register() after stop() refuses immediately, without touching the DB', async () => {
    const { reg, runs, selects } = registry();
    reg.stop();
    runs.set('run_y', { id: 'run_y', status: 'completed' });
    await expect(reg.register('run_y', NS, { timeoutMs: 1_000 })).rejects.toThrow(
      'daemon shutting down',
    );
    expect(selects()).toBe(0); // refused before the initial read
  });

  /* ---------------------------------------------------- p1-14: disconnect */

  it('an aborted signal frees the pending waiter and rejects it', async () => {
    const { reg, runs } = registry();
    runs.set('run_abort', { id: 'run_abort', status: 'running' });
    const controller = new AbortController();
    const p = reg.register('run_abort', NS, { timeoutMs: 30_000 }, controller.signal);
    await new Promise((r) => setTimeout(r, 5)); // let the registration land
    expect(reg.pending()).toBe(1);

    controller.abort();
    await expect(p).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('aborted by the client'),
    });
    // The waiter was freed on the abort — not left hanging to the 30s deadline.
    expect(reg.pending()).toBe(0);
    reg.stop();
  });

  it('an already-aborted signal rejects without registering', async () => {
    const { reg, runs, selects } = registry();
    runs.set('run_aborted', { id: 'run_aborted', status: 'running' });
    const controller = new AbortController();
    controller.abort(); // the client disconnected before the request landed
    await expect(
      reg.register('run_aborted', NS, { timeoutMs: 30_000 }, controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('aborted by the client'),
    });
    expect(reg.pending()).toBe(0);
    // The initial read was skipped: nobody is left to see an answer to this wait.
    expect(selects()).toBe(0);
    reg.stop();
  });

  it('a settled waiter ignores a late abort', async () => {
    const { reg, runs } = registry();
    runs.set('run_late', { id: 'run_late', status: 'running' });
    const controller = new AbortController();
    const p = reg.register('run_late', NS, { timeoutMs: 5_000 }, controller.signal);
    await new Promise((r) => setTimeout(r, 5)); // let the registration land
    runs.set('run_late', { id: 'run_late', status: 'completed', output: 'ok' });
    await reg.resolve('run_late');
    expect(await p).toEqual({ status: 'completed', output: 'ok', error: undefined });
    expect(reg.pending()).toBe(0);

    controller.abort(); // after settlement the abort is a no-op
    expect(reg.pending()).toBe(0);
    // ...and it must not have unsettled the promise: the result still comes back.
    expect(await p).toEqual({ status: 'completed', output: 'ok', error: undefined });
    reg.stop();
  });

  /* ---------------- abort listener lifecycle (round-three T6) ------------- */

  /** A signal stand-in that records listeners, so "was the abort listener
   *  detached on settle" is directly observable. */
  function recordingSignal() {
    const listeners = new Set<() => void>();
    const impl = {
      aborted: false,
      addEventListener: (_type: string, fn: () => void): void => {
        listeners.add(fn);
      },
      removeEventListener: (_type: string, fn: () => void): void => {
        listeners.delete(fn);
      },
    };
    const signal = impl as unknown as AbortSignal;
    /** Fire the recorded listeners the way an abort dispatch would. */
    const emitAbort = (): void => {
      impl.aborted = true;
      for (const fn of [...listeners]) fn();
    };
    return { signal, listeners, emitAbort };
  }

  it('a notification settle detaches the abort listener from the signal', async () => {
    const { reg, runs } = registry();
    runs.set('run_l1', { id: 'run_l1', status: 'running' });
    const s = recordingSignal();
    const p = reg.register('run_l1', NS, { timeoutMs: 5_000 }, s.signal);
    await new Promise((r) => setTimeout(r, 5)); // let the registration land
    expect(s.listeners.size).toBe(1);

    runs.set('run_l1', { id: 'run_l1', status: 'completed', output: 'ok' });
    await reg.resolve('run_l1');
    expect(await p).toEqual({ status: 'completed', output: 'ok', error: undefined });
    expect(s.listeners.size).toBe(0);
    reg.stop();
  });

  it('a timeout settle detaches the abort listener too', async () => {
    const { reg, runs } = registry();
    runs.set('run_l2', { id: 'run_l2', status: 'running' });
    const s = recordingSignal();
    const res = await reg.register('run_l2', NS, { timeoutMs: 40 }, s.signal);
    expect(res).toEqual({ status: 'running' });
    expect(s.listeners.size).toBe(0);
    reg.stop();
  });

  it('stop() detaches the abort listener of the waiter it rejects', async () => {
    const { reg, runs } = registry();
    runs.set('run_l3', { id: 'run_l3', status: 'running' });
    const s = recordingSignal();
    const p = reg.register('run_l3', NS, { timeoutMs: 5_000 }, s.signal);
    await new Promise((r) => setTimeout(r, 5)); // let the registration land
    expect(s.listeners.size).toBe(1);

    reg.stop();
    await expect(p).rejects.toThrow('daemon shutting down');
    expect(s.listeners.size).toBe(0);
  });

  it('a vanished run and a sweep settle both detach the listener', async () => {
    const { reg, runs } = registry();
    runs.set('run_l4', { id: 'run_l4', status: 'running' });
    const s4 = recordingSignal();
    const p4 = reg.register('run_l4', NS, { timeoutMs: 5_000 }, s4.signal);
    await new Promise((r) => setTimeout(r, 5));
    runs.delete('run_l4');
    await expect(p4).rejects.toThrow(KernelError);
    expect(s4.listeners.size).toBe(0);

    runs.set('run_l5', { id: 'run_l5', status: 'running' });
    const s5 = recordingSignal();
    const p5 = reg.register('run_l5', NS, { timeoutMs: 5_000 }, s5.signal);
    await new Promise((r) => setTimeout(r, 5));
    runs.set('run_l5', { id: 'run_l5', status: 'completed', output: 1 });
    expect((await p5).status).toBe('completed'); // the shared sweep settles it
    expect(s5.listeners.size).toBe(0);
    reg.stop();
  });

  it('the abort path settles the waiter and leaves no listener behind', async () => {
    const { reg, runs } = registry();
    runs.set('run_l6', { id: 'run_l6', status: 'running' });
    const s = recordingSignal();
    const p = reg.register('run_l6', NS, { timeoutMs: 5_000 }, s.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(reg.pending()).toBe(1);

    s.emitAbort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(reg.pending()).toBe(0);
    expect(s.listeners.size).toBe(0);
    reg.stop();
  });

  it('a run already terminal at register leaves no listener attached', async () => {
    const { reg, runs } = registry();
    runs.set('run_l7', { id: 'run_l7', status: 'completed', output: 'ok' });
    const s = recordingSignal();
    await reg.register('run_l7', NS, { timeoutMs: 5_000 }, s.signal);
    expect(s.listeners.size).toBe(0);
    reg.stop();
  });

  describe('registration and deadline races', () => {
    const registries: WaiterRegistry[] = [];
    const running = { id: 'run_race', status: 'running' };
    const completed = { ...running, status: 'completed', output: 'done' };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      for (const reg of registries.splice(0)) reg.stop();
      vi.useRealTimers();
    });

    function controlledRegistry(
      query: (sql: string, params?: unknown[]) => Promise<{ rows: FakeRun[] }>,
      pollMs = 10,
    ) {
      const counters = createNotifyCounters();
      const reg = createWaiterRegistry({
        pool: { query } as unknown as Parameters<typeof createWaiterRegistry>[0]['pool'],
        counters,
        pollMs,
      });
      registries.push(reg);
      return { reg, counters };
    }

    // Observe settlement without awaiting a potentially orphaned promise;
    // rejected late DB reads are also checked by Vitest's unhandled-error trap.
    function observe(promise: Promise<unknown>) {
      const settled = vi.fn();
      void promise.then(settled, settled);
      return settled;
    }

    describe.each(['stop', 'abort argument', 'abort option'] as const)('%s during the first read', (action) => {
      it.each(['running', 'terminal', 'not_found', 'reject'] as const)(
        'settles before a late %s and ignores that read afterwards',
        async (late) => {
          const read = deferred<{ rows: FakeRun[] }>();
          const query = vi.fn(() => read.promise);
          const { reg, counters } = controlledRegistry(query);
          const s = recordingSignal();
          const settled = observe(reg.register(running.id, NS, {
            timeoutMs: 5,
            signal: action === 'abort option' ? s.signal : undefined,
          }, action === 'abort option' ? undefined : s.signal));
          await vi.advanceTimersByTimeAsync(20);
          // No state has been read yet: a timeout cannot invent one.
          expect(settled).not.toHaveBeenCalled();
          expect(s.listeners.size).toBe(1);

          if (action === 'stop') reg.stop();
          else s.emitAbort();
          await vi.advanceTimersByTimeAsync(0);
          expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(
            action === 'stop' ? WaiterRegistryStoppedError : ResultWaitAbortedError,
          ));
          expect(s.listeners.size).toBe(0);
          expect(reg.pending()).toBe(0);
          reg.stop();
          reg.stop();

          if (late === 'reject') read.reject(new Error('late database failure'));
          else read.resolve({ rows: late === 'not_found' ? [] : [late === 'terminal' ? completed : running] });
          await vi.advanceTimersByTimeAsync(100);
          expect(settled).toHaveBeenCalledTimes(1);
          expect(reg.pending()).toBe(0);
          expect(query).toHaveBeenCalledTimes(1);
          expect(counters.waiterResolutions).toBe(0);
          expect(counters.waiterTimeouts).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        },
      );
    });

    describe.each(['reading', 'pending'] as const)('stop/abort precedence while %s', (phase) => {
      it.each(['stop', 'abort'] as const)('keeps the first %s outcome', async (first) => {
        const read = deferred<{ rows: FakeRun[] }>();
        const { reg, counters } = controlledRegistry(() => read.promise);
        const s = recordingSignal();
        const settled = observe(reg.register(running.id, NS, { timeoutMs: 30 }, s.signal));
        if (phase === 'pending') read.resolve({ rows: [running] });
        await vi.advanceTimersByTimeAsync(0);

        if (first === 'stop') {
          reg.stop();
          s.emitAbort();
        } else {
          s.emitAbort();
          reg.stop();
        }
        read.resolve({ rows: [running] });
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(
          first === 'stop' ? WaiterRegistryStoppedError : ResultWaitAbortedError,
        ));
        expect(reg.pending()).toBe(0);
        expect(s.listeners.size).toBe(0);
        expect(counters.waiterResolutions + counters.waiterTimeouts).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it('propagates an initial query error and removes its abort listener', async () => {
      const error = new Error('initial database failure');
      const { reg } = controlledRegistry(async () => { throw error; });
      const s = recordingSignal();
      await expect(reg.register(running.id, NS, {}, s.signal)).rejects.toBe(error);
      expect(reg.pending()).toBe(0);
      expect(s.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(1); // only the shared poller remains
    });

    it('starts the full budget only after the first non-terminal observation', async () => {
      const read = deferred<{ rows: FakeRun[] }>();
      const { reg, counters } = controlledRegistry(() => read.promise, 100);
      const settled = observe(reg.register(running.id, NS, { timeoutMs: 5 }));
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).not.toHaveBeenCalled();
      read.resolve({ rows: [running] });
      await vi.advanceTimersByTimeAsync(4);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledExactlyOnceWith({ status: 'running' });
      expect(counters.waiterTimeouts).toBe(1);
      expect(reg.pending()).toBe(0);
    });

    it.each([NaN, -1, -Infinity])('rejects invalid timeoutMs=%s before reading', async (timeoutMs) => {
      const query = vi.fn(async () => ({ rows: [running] }));
      const { reg } = controlledRegistry(query);
      const s = recordingSignal();
      await expect(reg.register(running.id, NS, { timeoutMs }, s.signal)).rejects.toMatchObject({ code: 'bad_request' });
      expect(query).not.toHaveBeenCalled();
      expect(reg.pending()).toBe(0);
      expect(s.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
    });

    it.each([false, true])('keeps the single-read zero budget semantics (throwOnTimeout=%s)', async (throwOnTimeout) => {
      const query = vi.fn(async () => ({ rows: [running] }));
      const { reg, counters } = controlledRegistry(query);
      const s = recordingSignal();
      await expect(reg.register(running.id, NS, { timeoutMs: 0, throwOnTimeout }, s.signal)).resolves.toEqual({ status: 'running' });
      expect(query).toHaveBeenCalledTimes(1);
      expect(reg.pending()).toBe(0);
      expect(s.listeners.size).toBe(0);
      expect(counters.waiterTimeouts).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('keeps Infinity pending without a deadline timer until cancellation', async () => {
      const { reg } = controlledRegistry(async () => ({ rows: [running] }));
      const s = recordingSignal();
      const settled = observe(reg.register(running.id, NS, { timeoutMs: Infinity }, s.signal));
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).not.toHaveBeenCalled();
      expect(reg.pending()).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      s.emitAbort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(ResultWaitAbortedError));
      expect(s.listeners.size).toBe(0);
    });

    describe.each(['errors', 'hung read'] as const)('deadline with subsequent batch %s', (failure) => {
      it.each([false, true])('uses the last observation at the deadline (throwOnTimeout=%s)', async (throwOnTimeout) => {
        const batch = deferred<{ rows: FakeRun[] }>();
        const query = vi.fn(async () => ({ rows: [running] }))
          .mockResolvedValueOnce({ rows: [running] })
          .mockResolvedValueOnce({ rows: [{ ...running, status: 'waiting' }] })
          .mockImplementation(() => failure === 'errors' ? Promise.reject(new Error('database down')) : batch.promise);
        const { reg, counters } = controlledRegistry(query);
        const s = recordingSignal();
        const settled = observe(reg.register(running.id, NS, { timeoutMs: 35, throwOnTimeout }, s.signal));
        await vi.advanceTimersByTimeAsync(34);
        expect(settled).not.toHaveBeenCalled();
        expect(reg.pending()).toBe(1);
        // A hung batch never causes overlapping retries; errors retry at the
        // shared cadence without postponing the independent deadline.
        expect(query).toHaveBeenCalledTimes(failure === 'errors' ? 4 : 3);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toHaveBeenCalledExactlyOnceWith(throwOnTimeout
          ? expect.any(ResultTimeoutError)
          : { status: 'waiting' });
        if (throwOnTimeout) {
          expect(settled.mock.calls[0]![0]).toMatchObject({ status: 'waiting' });
          expect(settled.mock.calls[0]![0].message).toContain(`run ${running.id} did not reach a terminal state within 35ms`);
        }
        expect(reg.pending()).toBe(0);
        expect(s.listeners.size).toBe(0);
        expect(counters.waiterTimeouts).toBe(1);
        expect(counters.waiterResolutions).toBe(0);
        expect(vi.getTimerCount()).toBe(1);
        batch.resolve({ rows: [completed] });
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toHaveBeenCalledTimes(1);
        expect(counters.waiterTimeouts).toBe(1);
        expect(counters.waiterResolutions).toBe(0);
      });
    });

    it('a non-terminal notification read updates the status used by the deadline', async () => {
      const query = vi.fn(async () => ({ rows: [running] }))
        .mockResolvedValueOnce({ rows: [running] })
        .mockResolvedValueOnce({ rows: [{ ...running, status: 'waiting' }] });
      const { reg } = controlledRegistry(query, 100);
      const settled = observe(reg.register(running.id, NS, { timeoutMs: 5 }));
      await vi.advanceTimersByTimeAsync(0);
      await reg.resolve(running.id);
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toHaveBeenCalledExactlyOnceWith({ status: 'waiting' });
      expect(query).toHaveBeenCalledTimes(2);
    });

    it.each(['terminal', 'not_found', 'deadline', 'abort', 'stop'] as const)(
      'settles once when %s wins against an in-flight sweep and notifications',
      async (winner) => {
        const read = deferred<{ rows: FakeRun[] }>();
        const query = vi.fn(() => read.promise).mockResolvedValueOnce({ rows: [running] });
        const { reg, counters } = controlledRegistry(query);
        const s = recordingSignal();
        const settled = observe(reg.register(running.id, NS, { timeoutMs: 35 }, s.signal));
        await vi.advanceTimersByTimeAsync(10); // one batch now in flight
        const notifications = Promise.all([reg.resolve(running.id), reg.resolve(running.id)]);
        if (winner === 'terminal' || winner === 'not_found') {
          read.resolve({ rows: winner === 'terminal' ? [completed] : [] });
          await notifications;
        } else if (winner === 'deadline') await vi.advanceTimersByTimeAsync(25);
        else if (winner === 'abort') s.emitAbort();
        else reg.stop();
        await vi.advanceTimersByTimeAsync(0);

        const expected = winner === 'terminal' ? { status: 'completed', output: 'done', error: undefined }
          : winner === 'not_found' ? expect.objectContaining({ code: 'not_found' })
          : winner === 'deadline' ? { status: 'running' }
          : expect.any(winner === 'abort' ? ResultWaitAbortedError : WaiterRegistryStoppedError);
        expect(settled).toHaveBeenCalledExactlyOnceWith(expected);
        expect(s.listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(winner === 'stop' ? 0 : 1);
        s.emitAbort();
        reg.stop();
        read.resolve({ rows: [completed] });
        await notifications;
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toHaveBeenCalledExactlyOnceWith(expected);
        expect(counters.waiterResolutions).toBe(winner === 'terminal' || winner === 'not_found' ? 1 : 0);
        expect(counters.waiterTimeouts).toBe(winner === 'deadline' ? 1 : 0);
        expect(reg.pending()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('splits deadlines longer than the signed 32-bit timer range without expiring early', async () => {
      const maxTimerMs = 2_147_483_647;
      const hung = deferred<{ rows: FakeRun[] }>();
      const query = vi.fn(() => hung.promise).mockResolvedValueOnce({ rows: [running] });
      const { reg, counters } = controlledRegistry(query, maxTimerMs);
      const settled = observe(reg.register(running.id, NS, { timeoutMs: maxTimerMs + 5 }));
      await vi.advanceTimersByTimeAsync(maxTimerMs + 4);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledExactlyOnceWith({ status: 'running' });
      expect(counters.waiterTimeouts).toBe(1);
      expect(reg.pending()).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('shares one batch per tick across distinct runs and duplicate waiters', async () => {
      const rows = [0, 1, 2].map((i) => ({ id: `run_${i}`, status: 'running' }));
      const ids = rows.map((row) => row.id);
      const query = vi.fn(async (sql: string, params?: unknown[]) => ({
        rows: sql.includes('ANY') ? rows : rows.filter((row) => row.id === params?.[0]),
      }));
      const { reg, counters } = controlledRegistry(query);
      const signals = [...ids, ids[0]!].map(() => recordingSignal());
      const settled = [...ids, ids[0]!].map((id, i) => observe(
        reg.register(id, NS, { timeoutMs: 100 }, signals[i]!.signal),
      ));
      await vi.advanceTimersByTimeAsync(0);
      expect(reg.pending()).toBe(4);
      expect(query).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(10);
      expect(query).toHaveBeenCalledTimes(5);
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining('ANY'), [ids]);
      for (const row of rows) row.status = 'completed';
      await vi.advanceTimersByTimeAsync(10);
      expect(query).toHaveBeenCalledTimes(6);
      for (const result of settled) {
        expect(result).toHaveBeenCalledExactlyOnceWith({ status: 'completed', output: undefined, error: undefined });
      }
      for (const s of signals) expect(s.listeners.size).toBe(0);
      expect(reg.pending()).toBe(0);
      expect(counters.waiterResolutions).toBe(4);
      expect(counters.waiterTimeouts).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
    });
  });

  /* ------------------------- route-level: a disconnect answers 499 */

  it('a request aborted mid-poll answers 499', async () => {
    const f = fakePool();
    f.runs.set('run_route', { id: 'run_route', status: 'running' });
    const reg = createWaiterRegistry({
      pool: f.pool,
      counters: createNotifyCounters(),
      pollMs: 20,
    });
    const app = createApp({ kernel: {} as Kernel, pool: f.pool, waiters: reg });
    const controller = new AbortController();
    const resP = app.fetch(
      new Request('http://localhost:4848/api/v1/runs/run_route/result?timeoutMs=30000', {
        signal: controller.signal,
      }),
    );
    // Wait for the waiter to land in the registry (the long-poll is pending).
    const deadline = Date.now() + 500;
    while (reg.pending() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(reg.pending()).toBe(1);

    controller.abort();
    const res = await resP;
    expect(res.status).toBe(499);
    expect(reg.pending()).toBe(0);
    reg.stop();
  });
});

describe('claim wake primitives', () => {
  it('a wake signal resolves an idle sleep immediately', async () => {
    const wake = createWakeSignal();
    const t0 = Date.now();
    const sleep = sleepWithWake(10_000, wake);
    setTimeout(() => wake.emit(), 20);
    await sleep;
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('without a wake signal it is a plain sleep', async () => {
    const t0 = Date.now();
    await sleepWithWake(30, null);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it('an unsubscribed listener no longer wakes future sleeps', async () => {
    const wake = createWakeSignal();
    const off = wake.subscribe(() => {});
    off();
    let fired = 0;
    wake.subscribe(() => {
      fired += 1;
    });
    wake.emit();
    expect(fired).toBe(1);
  });
});
