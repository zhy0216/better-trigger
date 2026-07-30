/* =============================================================================
   @better-trigger/worker — shutdown aborts in-flight runs.

   stop() used to sit out SHUTDOWN_DRAIN_MS (30s) waiting for a step whose result
   this process will never report. It now aborts ctx.signal first, so a step that
   honors the signal unwinds immediately. Driven against a fake kernel (no
   Postgres): the run is claimed once, blocks on ctx.signal, and stop() must
   return in well under the drain window without reporting a failure.
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
  const calls = { reportStep: [] as any[], failRun: [] as any[], completeRun: [] as any[] };
  let handedOut = false;
  const kernel = {
    registerWorker: async () => ({ workerId: 'w1' }),
    startOrchestrator: () => ({ stop: () => {} }),
    claimRuns: async () => {
      if (handedOut) return [];
      handedOut = true;
      return [RUN];
    },
    heartbeat: async () => ({ cancelRunIds: [] }),
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

describe('startWorkerRuntime().stop()', () => {
  it('aborts in-flight steps instead of waiting out the drain window', async () => {
    const { kernel, calls } = fakeKernel();
    let started!: () => void;
    const stepStarted = new Promise<void>((r) => {
      started = r;
    });
    let reason: RunAbortedError | undefined;

    const slow = task('slow', (_payload: unknown, ctx) =>
      ctx.step('llm-call', () => {
        started();
        // The agent-shaped step: minutes long, cut short only by ctx.signal.
        return new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              reason = ctx.signal.reason;
              reject(ctx.signal.reason);
            },
            { once: true },
          );
        });
      }),
    );

    const handle = await startWorkerRuntime({ kernel }, { tasks: [slow], concurrency: 1 });
    await stepStarted;

    const t0 = Date.now();
    await handle.stop();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2_000); // SHUTDOWN_DRAIN_MS is 30s
    expect(isRunAborted(reason)).toBe(true);
    expect(reason?.reason).toBe('shutting_down');
    // The lease reaper requeues the run; nothing is written for this attempt.
    expect(calls.reportStep).toEqual([]);
    expect(calls.failRun).toEqual([]);
    expect(calls.completeRun).toEqual([]);
  });
});
