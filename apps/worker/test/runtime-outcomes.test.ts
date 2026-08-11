/* =============================================================================
   @better-trigger/worker — runs_total comes from real executions (O4).

   `counters.runOutcomes[result.type] += 1` in the claim loop is the only writer
   of the `runs_total{outcome}` family, and metrics.test.ts can only prove the
   renderer: hand it a counters object with numbers already in it and the family
   renders whether or not anything ever increments. Delete that line and the
   metric reports 0 forever with nothing going red.

   So each case here runs an actual task through the real Executor against a
   fake kernel (no Postgres) and reads the counter off the WorkerHandle — one
   case per Executor result type, because the index is what makes the four
   labels distinct.
   ============================================================================= */
import type { ClaimedRun } from '@better-trigger/core';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { KernelError, type Kernel } from '@better-trigger/kernel';
import { task } from 'better-trigger';
import { describe, expect, it } from 'vitest';
import { startWorkerRuntime } from '../src/runtime';

const RUN: ClaimedRun = {
  id: 'run_1',
  taskId: 'demo',
  payload: {},
  attempt: 1,
  maxAttempts: 3,
  codeVersion: null,
  projectId: 'default',
  env: 'dev',
  steps: [],
  fencingToken: 1,
};

interface Behavior {
  /** completeRun rejects with this code — 'stale_lease' is a lost claim. */
  completeRunRejectsWith?: 'stale_lease' | 'run_not_running';
}

/** Hands out RUN exactly once, so the outcome counts are exact. */
function fakeKernel(b: Behavior = {}) {
  const calls = { completeRun: 0, failRun: 0, suspendRun: 0 };
  let handedOut = false;
  const kernel = {
    registerWorker: async () => ({ workerId: 'w1' }),
    startOrchestrator: () => ({ stop: () => {} }),
    claimRuns: async () => {
      if (handedOut) return [];
      handedOut = true;
      return [RUN];
    },
    heartbeat: async () => ({ cancelRunIds: [], lostRunIds: [] }),
    reportStep: async () => {},
    completeRun: async () => {
      calls.completeRun += 1;
      if (b.completeRunRejectsWith) {
        throw new KernelError(b.completeRunRejectsWith, 'the claim moved on');
      }
    },
    failRun: async () => {
      calls.failRun += 1;
      return { willRetry: false };
    },
    suspendRun: async () => {
      calls.suspendRun += 1;
      // resumed:false is what parks the run — the executor unwinds with a
      // SuspendSignal, which is the 'suspended' outcome.
      return { resumed: false };
    },
    appendLogs: async () => {},
  } as unknown as Kernel;
  return { kernel, calls };
}

async function waitFor(pred: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Zeros for every outcome except the ones named. */
function outcomes(...counted: Array<'completed' | 'failed' | 'suspended' | 'abandoned'>) {
  const base = { completed: 0, failed: 0, suspended: 0, abandoned: 0 };
  for (const key of counted) base[key] = 1;
  return base;
}

describe('runs_total sources', () => {
  it('counts a run that returned as completed', async () => {
    const { kernel, calls } = fakeKernel();
    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [task('demo', async () => 'done')], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => calls.completeRun > 0);
    await handle.stop();

    expect(handle.counters.runOutcomes).toEqual(outcomes('completed'));
  }, 15_000);

  it('counts a run that threw as failed', async () => {
    const { kernel, calls } = fakeKernel();
    const boom = task('demo', async () => {
      throw new Error('task blew up');
    });
    const handle = await startWorkerRuntime({ kernel }, { tasks: [boom], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] });
    await waitFor(() => calls.failRun > 0);
    await handle.stop();

    // 'failed' is the executor's verdict on this attempt, not the run's final
    // status — the kernel may still schedule another one.
    expect(handle.counters.runOutcomes).toEqual(outcomes('failed'));
  }, 15_000);

  it('counts a run parked on a wait as suspended', async () => {
    const { kernel, calls } = fakeKernel();
    const waiting = task('demo', async (_payload: unknown, ctx) => {
      await ctx.wait.for('1h');
      return 'never reached in this pass';
    });
    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [waiting], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => calls.suspendRun > 0);
    await handle.stop();

    expect(handle.counters.runOutcomes).toEqual(outcomes('suspended'));
    // The pass ended on the wait: nothing was completed or failed.
    expect(calls.completeRun).toBe(0);
    expect(calls.failRun).toBe(0);
  }, 15_000);

  it('counts a claim the kernel rejected as abandoned', async () => {
    // A lost lease: the run finished here, but the kernel says this worker no
    // longer owns it. The attempt is handed back silently, which is exactly the
    // outcome an operator cannot see any other way.
    const { kernel, calls } = fakeKernel({ completeRunRejectsWith: 'stale_lease' });
    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [task('demo', async () => 'done')], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => calls.completeRun > 0);
    await waitFor(() => handle.counters.runOutcomes.abandoned > 0);
    await handle.stop();

    expect(handle.counters.runOutcomes).toEqual(outcomes('abandoned'));
    // Swallowed by the executor, not by the loop-level guard.
    expect(handle.counters.executorErrors).toBe(0);
  }, 15_000);

  it('leaves every outcome at zero on a worker that claimed nothing', async () => {
    const kernel = {
      registerWorker: async () => ({ workerId: 'w1' }),
      startOrchestrator: () => ({ stop: () => {} }),
      claimRuns: async () => [],
      heartbeat: async () => ({ cancelRunIds: [], lostRunIds: [] }),
    } as unknown as Kernel;

    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [task('demo', async () => 'done')], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await new Promise((r) => setTimeout(r, 200));
    await handle.stop();

    expect(handle.counters.runOutcomes).toEqual(outcomes());
  }, 15_000);
});
