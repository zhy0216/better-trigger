/* =============================================================================
   @better-trigger/worker — the crash line names the runs that died with it.

   crash.test.ts drives the real CLI, but a spawned daemon with no --tasks is
   never executing anything: it can only ever prove that the line says
   `in-flight=none`. The half that matters operationally — "these three runs
   were mid-execution when the process vanished, go look at them" — is covered
   here, from both ends:

     - WorkerHandle.inFlightRunIds() really reports the runs being executed
       (fake kernel, no Postgres: a run parks inside a step and stays there);
     - formatCrashContext() renders a non-empty list into the line the crash
       handlers print.

   Together they fail if the id list degenerates to [] or stops being rendered.
   ============================================================================= */
import type { ClaimedRun } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import { task } from 'better-trigger';
import { describe, expect, it } from 'vitest';
import { formatCrashContext } from '../src/observability';
import { startWorkerRuntime } from '../src/runtime';

function claimedRun(id: string): ClaimedRun {
  return {
    id,
    taskId: 'parked',
    payload: {},
    attempt: 1,
    maxAttempts: 3,
    codeVersion: null,
    env: 'dev',
    steps: [],
    fencingToken: 1,
  };
}

/** Hands out each run once, then nothing — two slots, two in-flight runs. */
function fakeKernel(runs: ClaimedRun[]) {
  const queue = [...runs];
  return {
    registerWorker: async () => ({ workerId: 'w_crash' }),
    startOrchestrator: () => ({ stop: () => {}, counters: {} }),
    claimRuns: async () => {
      const next = queue.shift();
      return next ? [next] : [];
    },
    heartbeat: async () => ({ cancelRunIds: [] }),
    reportStep: async () => {},
    failRun: async () => {},
    completeRun: async () => {},
    appendLogs: async () => {},
  } as unknown as Kernel;
}

describe('formatCrashContext()', () => {
  it('renders the in-flight run ids', () => {
    expect(formatCrashContext('uncaughtException', 'w_1', ['run_a', 'run_b'])).toBe(
      '[better-trigger] fatal uncaughtException: exiting. worker=w_1 in-flight=run_a,run_b',
    );
  });

  it('says none rather than an empty gap when there is nothing to name', () => {
    expect(formatCrashContext('unhandledRejection', undefined, [])).toBe(
      '[better-trigger] fatal unhandledRejection: exiting. worker=none in-flight=none',
    );
  });
});

describe('WorkerHandle.inFlightRunIds()', () => {
  it('reports the runs being executed, and they render into the crash line', async () => {
    let running = 0;
    let bothRunning!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      bothRunning = resolve;
    });

    // Parks inside a step until the runtime aborts it: exactly the state a
    // fatal fault catches a busy worker in.
    const parked = task('parked', (_payload: unknown, ctx) =>
      ctx.step('park', () => {
        if (++running === 2) bothRunning();
        return new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        });
      }),
    );

    const handle = await startWorkerRuntime(
      { kernel: fakeKernel([claimedRun('run_a'), claimedRun('run_b')]) },
      { tasks: [parked], concurrency: 2 },
    );
    await bothStarted;

    try {
      const runIds = handle.inFlightRunIds();
      expect([...runIds].sort()).toEqual(['run_a', 'run_b']);

      const line = formatCrashContext('uncaughtException', handle.workerId, runIds);
      expect(line).toContain('worker=w_crash');
      // The point of the whole exercise: the ids reach the log.
      expect(line).toContain('run_a');
      expect(line).toContain('run_b');
      expect(line).not.toContain('in-flight=none');
    } finally {
      await handle.stop();
    }

    // Drained: nothing left to name.
    expect(handle.inFlightRunIds()).toEqual([]);
  }, 10_000);
});
