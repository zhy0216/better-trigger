/* =============================================================================
   @better-trigger/worker — a heartbeat cancel reaches ctx.signal.

   The executor's markCanceled() is unit-tested directly (executor-signal.test.ts);
   what this pins is the wiring: a cancel arrives only as `cancelRunIds` on a
   heartbeat response, so the heartbeat loop is the one place that can turn a
   dashboard click into an aborted signal. Driven against a fake kernel (no
   Postgres) with leaseMs chosen so the heartbeat ticks at its 500ms floor.
   ============================================================================= */
import type { ClaimedRun } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import { isRunAborted, task, type RunAbortedError } from 'better-trigger';
import { describe, expect, it } from 'vitest';
import { startWorkerRuntime } from '../src/runtime';

const RUN: ClaimedRun = {
  id: 'run_1',
  taskId: 'slow',
  payload: {},
  attempt: 1,
  maxAttempts: 3,
  codeVersion: null,
  env: 'dev',
  steps: [],
  fencingToken: 1,
};

function fakeKernel() {
  const calls = {
    reportStep: [] as any[],
    failRun: [] as any[],
    completeRun: [] as any[],
    heartbeatRunIds: [] as string[][],
  };
  let handedOut = false;
  const kernel = {
    registerWorker: async () => ({ workerId: 'w1' }),
    startOrchestrator: () => ({ stop: () => {} }),
    claimRuns: async () => {
      if (handedOut) return [];
      handedOut = true;
      return [RUN];
    },
    // What a cancel looks like on the wire: the run id comes back on the very
    // heartbeat that renews its lease.
    heartbeat: async ({ runIds }: { runIds: string[] }) => {
      calls.heartbeatRunIds.push(runIds);
      return { cancelRunIds: runIds.filter((id) => id === RUN.id) };
    },
    reportStep: async (input: any) => {
      calls.reportStep.push(input);
    },
    failRun: async (input: any) => {
      calls.failRun.push(input);
    },
    completeRun: async (input: any) => {
      calls.completeRun.push(input);
    },
    appendLogs: async () => {},
  } as unknown as Kernel;
  return { kernel, calls };
}

describe('heartbeat cancel', () => {
  it('aborts ctx.signal with reason "canceled" mid-step', async () => {
    const { kernel, calls } = fakeKernel();
    let sawAbort!: (reason: unknown) => void;
    const aborted = new Promise<unknown>((r) => {
      sawAbort = r;
    });

    const slow = task('slow', (_payload: unknown, ctx) =>
      ctx.step('llm-call', () => {
        // The agent-shaped step: minutes long, cut short only by ctx.signal.
        return new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              sawAbort(ctx.signal.reason);
              reject(ctx.signal.reason);
            },
            { once: true },
          );
        });
      }),
    );

    // leaseMs/3 < the 500ms heartbeat floor, so the first tick lands at 500ms.
    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [slow], concurrency: 1, leaseMs: 1_200 },
    );
    const reason = (await aborted) as RunAbortedError;
    await handle.stop();

    expect(isRunAborted(reason)).toBe(true);
    expect(reason.reason).toBe('canceled');
    // The heartbeat is what carried it: the run was in the renewal set.
    expect(calls.heartbeatRunIds.some((ids) => ids.includes(RUN.id))).toBe(true);
    // A canceled run's output is discarded, so the attempt writes nothing —
    // the kernel would reject a step row on a canceled run anyway.
    expect(calls.reportStep).toEqual([]);
    expect(calls.failRun).toEqual([]);
    expect(calls.completeRun).toEqual([]);
  }, 10_000);
});
