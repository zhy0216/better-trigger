/* =============================================================================
   @better-trigger/worker — a heartbeat lease loss reaches ctx.signal (C2).

   Sibling of runtime-cancel.test.ts, and for the same reason: the executor's
   markLost() is unit-tested directly (executor-signal.test.ts), so what is
   worth pinning is the wiring. Lease loss only ever arrives as `lostRunIds` on
   a heartbeat response, which makes the heartbeat loop the single place that
   can turn "the reaper gave your run to someone else" into an aborted signal —
   the whole point of C2 being that a 5-minute LLM step should not keep burning
   tokens for a result no kernel write will accept.

   Driven against a fake kernel (no Postgres) with leaseMs chosen so the
   heartbeat ticks at its 500ms floor.
   ============================================================================= */
import type { ClaimedRun } from '@better-trigger/core';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
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
  projectId: 'default',
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
    // The reaper took the claim: the renewal no longer covers this run, so the
    // heartbeat that asked for it reports it back as lost — never as canceled,
    // which is a different instruction with a different abort reason.
    heartbeat: async ({ runIds }: { runIds: string[] }) => {
      calls.heartbeatRunIds.push(runIds);
      return { cancelRunIds: [], lostRunIds: runIds.filter((id) => id === RUN.id) };
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
    releaseClaims: async () => ({ releasedRunIds: [] }),
    deregisterWorker: async () => {},
  } as unknown as Kernel;
  return { kernel, calls };
}

describe('heartbeat lease loss', () => {
  it('aborts ctx.signal with reason "lease_lost" mid-step', async () => {
    const { kernel, calls } = fakeKernel();
    let sawAbort!: (reason: unknown) => void;
    const aborted = new Promise<unknown>((r) => {
      sawAbort = r;
    });

    const slow = task('slow', (_payload: unknown, ctx) =>
      ctx.step('llm-call', () => {
        // The step C2 exists for: minutes of tokens, cut short only by
        // ctx.signal.
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
      { tasks: [slow], concurrency: 1, leaseMs: 1_200, namespaces: [DEFAULT_NAMESPACE] },
    );
    const reason = (await aborted) as RunAbortedError;
    await handle.stop();

    expect(isRunAborted(reason)).toBe(true);
    expect(reason.reason).toBe('lease_lost');
    // The heartbeat is what carried it: the run was in the renewal set.
    expect(calls.heartbeatRunIds.some((ids) => ids.includes(RUN.id))).toBe(true);
    // And the executor writes nothing on the way out. Whoever holds the claim
    // now owns this run; a step row or a failure from here would be fenced off
    // anyway, and a failure would additionally charge an attempt for a
    // handover that is not the user code's fault.
    expect(calls.reportStep).toEqual([]);
    expect(calls.failRun).toEqual([]);
    expect(calls.completeRun).toEqual([]);
  }, 10_000);
});
