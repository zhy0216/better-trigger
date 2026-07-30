/* =============================================================================
   @better-trigger/worker — ctx.signal (cooperative run abort) unit tests.

   The executor is exercised against a recording fake kernel (no Postgres): what
   matters here is when ctx.signal fires, what reason it carries, and that an
   aborted attempt writes NOTHING — a canceled run's step row would be rejected
   anyway, and a drained one must not burn an attempt on a handover.
   ============================================================================= */
import type { ClaimedRun, LogEntry, StepSnapshot } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import { isRunAborted } from 'better-trigger';
import type { ExecutorTask } from 'better-trigger/internal';
import { describe, expect, it } from 'vitest';
import { Executor } from '../src/executor';

/** Records every write the executor attempts; all of them succeed. */
function fakeKernel() {
  const calls = {
    reportStep: [] as any[],
    failRun: [] as any[],
    completeRun: [] as any[],
    logs: [] as LogEntry[],
  };
  const kernel = {
    reportStep: async (input: any) => {
      calls.reportStep.push(input);
    },
    failRun: async (input: any) => {
      calls.failRun.push(input);
    },
    completeRun: async (input: any) => {
      calls.completeRun.push(input);
    },
    appendLogs: async (_runId: string, logs: LogEntry[]) => {
      calls.logs.push(...logs);
    },
  } as unknown as Kernel;
  return { kernel, calls };
}

const claimed = (steps: StepSnapshot[] = []): ClaimedRun => ({
  id: 'run_1',
  taskId: 'demo',
  payload: { n: 1 },
  attempt: 1,
  maxAttempts: 3,
  codeVersion: null,
  env: 'dev',
  steps,
  fencingToken: 7,
});

/** A step fn that only settles when the run is aborted — the LLM-call stand-in. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Task whose single step blocks until ctx.signal aborts. */
function blockingTask(onStart: () => void): ExecutorTask {
  return {
    id: 'demo',
    run: (_payload, ctx) =>
      ctx.step('llm-call', () => {
        onStart();
        return untilAborted(ctx.signal);
      }),
  };
}

describe('ctx.signal', () => {
  it('is present and un-aborted before anything happens', () => {
    const { kernel } = fakeKernel();
    const ex = new Executor(kernel, blockingTask(() => {}), claimed(), 'w1', null);
    expect(ex.ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ex.ctx.signal.aborted).toBe(false);
    expect(ex.ctx.signal.reason).toBeUndefined();
  });

  it('stays un-aborted through a normal completion', async () => {
    const { kernel, calls } = fakeKernel();
    const task: ExecutorTask = {
      id: 'demo',
      run: (_payload, ctx) => ctx.step('quick', () => 'ok'),
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);
    expect(await ex.execute()).toEqual({ type: 'completed', output: 'ok' });
    expect(ex.ctx.signal.aborted).toBe(false);
    expect(calls.completeRun).toHaveLength(1);
  });

  it('aborts with reason "canceled" when a heartbeat reports a cancel', async () => {
    const { kernel, calls } = fakeKernel();
    const started = deferred();
    const ex = new Executor(kernel, blockingTask(started.resolve), claimed(), 'w1', null);

    const running = ex.execute();
    await started.promise; // the step fn is in flight
    expect(ex.ctx.signal.aborted).toBe(false);
    ex.markCanceled();

    expect(await running).toEqual({ type: 'abandoned' });
    expect(ex.ctx.signal.aborted).toBe(true);
    expect(isRunAborted(ex.ctx.signal.reason)).toBe(true);
    expect(ex.ctx.signal.reason.reason).toBe('canceled');
    // The output is already discarded: no failed step row, no run failure.
    expect(calls.reportStep).toEqual([]);
    expect(calls.failRun).toEqual([]);
    expect(calls.completeRun).toEqual([]);
  });

  it('aborts with reason "shutting_down" and burns no attempt', async () => {
    const { kernel, calls } = fakeKernel();
    const started = deferred();
    const ex = new Executor(kernel, blockingTask(started.resolve), claimed(), 'w1', null);

    const running = ex.execute();
    await started.promise;
    ex.markShuttingDown();

    expect(await running).toEqual({ type: 'abandoned' });
    expect(ex.ctx.signal.reason.reason).toBe('shutting_down');
    // The lease reaper requeues the run; a failed row would consume attempt 1.
    expect(calls.reportStep).toEqual([]);
    expect(calls.failRun).toEqual([]);
  });

  it('aborts with reason "lease_lost" via the C2 seam (markLost)', async () => {
    const { kernel, calls } = fakeKernel();
    const started = deferred();
    const ex = new Executor(kernel, blockingTask(started.resolve), claimed(), 'w1', null);

    const running = ex.execute();
    await started.promise;
    ex.markLost();

    expect(await running).toEqual({ type: 'abandoned' });
    expect(ex.ctx.signal.reason.reason).toBe('lease_lost');
    expect(calls.reportStep).toEqual([]);
    expect(calls.failRun).toEqual([]);
  });

  it('keeps the first reason when abort fires twice', async () => {
    const { kernel } = fakeKernel();
    const started = deferred();
    const ex = new Executor(kernel, blockingTask(started.resolve), claimed(), 'w1', null);

    const running = ex.execute();
    await started.promise;
    ex.markCanceled();
    ex.markShuttingDown(); // a stop() racing the cancel must not relabel it

    await running;
    expect(ex.ctx.signal.reason.reason).toBe('canceled');
  });

  it('aborts an error thrown between steps into an abandonment, not a failure', async () => {
    const { kernel, calls } = fakeKernel();
    const started = deferred();
    // No ctx.step: the abort surfaces in run() itself.
    const task: ExecutorTask = {
      id: 'demo',
      run: (_payload, ctx) => {
        started.resolve();
        return untilAborted(ctx.signal);
      },
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    const running = ex.execute();
    await started.promise;
    ex.markShuttingDown();

    expect(await running).toEqual({ type: 'abandoned' });
    expect(calls.failRun).toEqual([]);
  });

  it('is cooperative: a step that ignores it still reports and completes', async () => {
    const { kernel, calls } = fakeKernel();
    const started = deferred();
    const release = deferred();
    const task: ExecutorTask = {
      id: 'demo',
      run: (_payload, ctx) =>
        ctx.step('stubborn', async () => {
          started.resolve();
          await release.promise; // never looks at ctx.signal
          return 'done anyway';
        }),
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    const running = ex.execute();
    await started.promise;
    ex.markShuttingDown();
    release.resolve();

    expect(await running).toEqual({ type: 'completed', output: 'done anyway' });
    expect(calls.reportStep).toHaveLength(1);
    expect(calls.completeRun).toHaveLength(1);
  });

  it('leaves cancel enforcement at step boundaries intact', async () => {
    const { kernel, calls } = fakeKernel();
    const started = deferred();
    const seen: unknown[] = [];
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        seen.push(await ctx.step('first', () => (started.resolve(), 'a')));
        // Yield so markCanceled() lands between the two steps.
        await new Promise((r) => setTimeout(r, 5));
        seen.push(await ctx.step('second', () => 'b'));
        return 'never';
      },
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    const running = ex.execute();
    await started.promise;
    ex.markCanceled();

    expect(await running).toEqual({ type: 'abandoned' });
    expect(seen).toEqual(['a']); // checkCanceled stopped the second step
    expect(calls.reportStep).toHaveLength(1); // only 'first'
    expect(calls.failRun).toEqual([]);
  });

  it('gives a replayed run a signal too, alongside memoized steps', async () => {
    const { kernel, calls } = fakeKernel();
    const started = deferred();
    const seen: unknown[] = [];
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        seen.push(await ctx.step('cached-one', () => 'fresh'));
        return ctx.step('llm-call', () => {
          started.resolve();
          return untilAborted(ctx.signal);
        });
      },
    };
    const snapshot: StepSnapshot[] = [
      { seq: 0, kind: 'step', label: 'cached-one', status: 'completed', output: 'memoized' },
    ];
    const ex = new Executor(kernel, task, claimed(snapshot), 'w1', null);

    const running = ex.execute();
    await started.promise;
    ex.markCanceled();

    expect(await running).toEqual({ type: 'abandoned' });
    expect(seen).toEqual(['memoized']); // seq 0 replayed from the ledger
    expect(ex.ctx.signal.reason.reason).toBe('canceled');
    expect(calls.reportStep).toEqual([]); // the cached step is not re-reported
  });
});
