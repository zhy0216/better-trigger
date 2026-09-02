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
import { describe, expect, it } from 'vitest';
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
