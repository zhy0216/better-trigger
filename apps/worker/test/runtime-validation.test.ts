/* =============================================================================
   @better-trigger/worker — T2: startWorkerRuntime() validates its inputs.

   The library entry point (index.ts re-exports startWorkerRuntime) is a public
   surface the CLI and the embedded host do not sit in front of, so it used to
   hand a rejected config straight to the kernel: a lease below 3 × the heartbeat
   renewal floor (p1-16) lets the reaper eat a live run's recovery budget;
   non-positive / non-integer concurrency starts zero claim loops (an idle daemon
   that still serves the API); an empty task or namespace list yields an
   infinitely-throttled claim-error loop. All four must now throw at the entry,
   naming the parameter, before registerWorker / startOrchestrator is ever
   reached.
   ============================================================================= */
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import { task } from 'better-trigger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorkerRuntime } from '../src/runtime';

const demo = task('demo', async () => 'ok');

/** A kernel that fails loudly if the guard is ever bypassed. */
function mustNotBeReached(): Kernel {
  return {
    registerWorker: async () => {
      throw new Error('registerWorker must not be reached with invalid options');
    },
    startOrchestrator: () => {
      throw new Error('startOrchestrator must not be reached with invalid options');
    },
  } as unknown as Kernel;
}

describe('startWorkerRuntime input validation (T2)', () => {
  it('rejects a lease below the heartbeat renewal floor', async () => {
    await expect(
      startWorkerRuntime(
        { kernel: mustNotBeReached() },
        { tasks: [demo], namespaces: [DEFAULT_NAMESPACE], leaseMs: 1_000 },
      ),
    ).rejects.toThrow(/leaseMs/);
  });

  it('rejects a non-integer lease', async () => {
    await expect(
      startWorkerRuntime(
        { kernel: mustNotBeReached() },
        { tasks: [demo], namespaces: [DEFAULT_NAMESPACE], leaseMs: 60_000.5 },
      ),
    ).rejects.toThrow(/leaseMs/);
  });

  it('rejects zero, negative, and fractional concurrency', async () => {
    for (const concurrency of [0, -1, 2.5]) {
      await expect(
        startWorkerRuntime(
          { kernel: mustNotBeReached() },
          { tasks: [demo], namespaces: [DEFAULT_NAMESPACE], concurrency },
        ),
      ).rejects.toThrow(/concurrency/);
    }
  });

  it('rejects an empty task list', async () => {
    await expect(
      startWorkerRuntime(
        { kernel: mustNotBeReached() },
        { tasks: [], namespaces: [DEFAULT_NAMESPACE] },
      ),
    ).rejects.toThrow(/tasks/);
  });

  it('rejects an empty namespace list', async () => {
    await expect(
      startWorkerRuntime(
        { kernel: mustNotBeReached() },
        { tasks: [demo], namespaces: [] },
      ),
    ).rejects.toThrow(/namespaces/);
  });

  it('lets a valid config through to the kernel unchanged', async () => {
    const handle = await startWorkerRuntime(
      { kernel: idleKernel() },
      {
        tasks: [demo],
        namespaces: [DEFAULT_NAMESPACE],
        concurrency: 1,
        leaseMs: 60_000,
      },
    );
    expect(handle.workerId).toBe('w1');
    await handle.stop();
  });
});

function idleKernel(): Kernel {
  return {
    registerWorker: async () => ({ workerId: 'w1' }),
    startOrchestrator: () => ({ stop: () => {}, counters: {} }),
    claimRuns: async () => [],
    heartbeat: async () => ({ cancelRunIds: [], lostRunIds: [] }),
    releaseClaims: async () => ({ releasedRunIds: [] }),
    deregisterWorker: async () => {},
  } as unknown as Kernel;
}

describe('runtime process timer bounds', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('rejects invalid leases before registration or any timer', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    for (const leaseMs of [NaN, Infinity, 6_442_450_944, Number.MAX_SAFE_INTEGER + 1, '60000', null]) {
      await expect(startWorkerRuntime({ kernel: mustNotBeReached() }, {
        tasks: [demo], namespaces: [DEFAULT_NAMESPACE], leaseMs: leaseMs as number,
      })).rejects.toThrow('leaseMs');
      expect(timer).not.toHaveBeenCalled();
    }
  });

  it.each(['timerIntervalMs', 'cronIntervalMs', 'reaperIntervalMs', 'gcIntervalMs', 'strandedIntervalMs'])(
    'rejects invalid %s before registering the worker', async (name) => {
      const timer = vi.spyOn(globalThis, 'setTimeout');
      for (const value of [0, -1, 1.5, NaN, Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1, '1000', null]) {
        await expect(startWorkerRuntime({
          kernel: mustNotBeReached(), orchestrator: { [name]: value },
        }, { tasks: [demo], namespaces: [DEFAULT_NAMESPACE] })).rejects.toThrow(name);
        expect(timer).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [1500, 500], [undefined, 20_000], [2_147_483_648, 715_827_882], [6_442_450_943, 2_147_483_647],
  ])('lease %s schedules heartbeat %i and is preserved for claims and renewals', async (leaseMs, heartbeatMs) => {
    const kernel = idleKernel();
    const claim = vi.spyOn(kernel, 'claimRuns');
    const heartbeat = vi.spyOn(kernel, 'heartbeat');
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const handle = await startWorkerRuntime({ kernel }, {
      tasks: [demo], namespaces: [DEFAULT_NAMESPACE], concurrency: 1, leaseMs,
    });
    try {
      expect(timer.mock.calls[0]?.[1]).toBe(heartbeatMs);
      expect(claim).toHaveBeenCalledWith(expect.objectContaining({ leaseMs: leaseMs ?? 60_000 }));
      // Fire only the captured heartbeat, without advancing through weeks of claim polls.
      (timer.mock.calls[0]![0] as () => void)();
      await Promise.resolve();
      expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({ leaseMs: leaseMs ?? 60_000 }));
      expect(timer.mock.calls.map((call) => call[1])).toContain(heartbeatMs);
    } finally {
      const stopped = handle.stop();
      await vi.advanceTimersByTimeAsync(2500);
      await stopped;
    }
  });
});
