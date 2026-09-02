/* =============================================================================
   @better-trigger/worker — T1: a deterministic ctx.wait argument error must not
   spend the retry budget.

   ctx.wait.for / ctx.wait.until evaluate their argument (durationToDate, or
   Date#toISOString) BEFORE doWait takes a replay position. A bad duration
   (parseDuration's Error, durationToDate's out-of-range KernelError) or an
   invalid Date (toISOString's RangeError) throws between steps and lands in
   handleThrown. Pre-fix, only isAbortError decided retryability, so the run
   was failed WITH this.task.retry attached — the kernel rescheduled it and
   every replay re-raised the identical throw until the attempts ran out,
   reaching the same terminal state the hard way. The wrapper now converts them
   to a non-retryable AbortError; these tests pin that (failRun sees
   abort:true / retry:undefined), against a recording fake kernel. No Postgres.
   ============================================================================= */
import type { ClaimedRun, LogEntry } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import type { ExecutorTask } from 'better-trigger/internal';
import { describe, expect, it } from 'vitest';
import { Executor } from '../src/executor';

function fakeKernel() {
  const calls = {
    failRun: [] as unknown[],
    completeRun: [] as unknown[],
    reportStep: [] as unknown[],
    suspendRun: [] as unknown[],
  };
  const kernel = {
    failRun: async (input: unknown) => {
      calls.failRun.push(input);
    },
    completeRun: async (input: unknown) => {
      calls.completeRun.push(input);
    },
    reportStep: async (input: unknown) => {
      calls.reportStep.push(input);
    },
    suspendRun: async (input: unknown) => {
      calls.suspendRun.push(input);
      throw new Error('suspendRun must not be reached: the argument threw first');
    },
    appendLogs: async (_runId: string, _ns: unknown, _logs: LogEntry[]) => {},
  } as unknown as Kernel;
  return { kernel, calls };
}

const claimed = (): ClaimedRun => ({
  id: 'run_1',
  taskId: 'demo',
  payload: {},
  attempt: 1,
  maxAttempts: 3,
  codeVersion: null,
  projectId: 'default',
  env: 'dev',
  steps: [],
  fencingToken: 7,
});

// A generous retry policy so the test is meaningful: if the failure were
// mis-classified as retryable, handleThrown would hand this to failRun and the
// kernel would reschedule. Non-retryable means failRun sees no policy at all.
const retry = { maxAttempts: 5, initialIntervalMs: 100, factor: 2 };

function taskWith(run: ExecutorTask['run']): ExecutorTask {
  return { id: 'demo', retry, run };
}

describe('ctx.wait argument errors are non-retryable (T1)', () => {
  it('ctx.wait.for("bogus") fails the run once, without a retry policy', async () => {
    const { kernel, calls } = fakeKernel();
    const ex = new Executor(kernel, taskWith(async (_p, ctx) => {
      await ctx.wait.for('bogus');
    }), claimed(), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'failed' });
    expect(calls.failRun).toHaveLength(1); // one attempt reported, no reschedule
    expect(calls.failRun[0]).toMatchObject({ abort: true, retry: undefined });
    expect((calls.failRun[0] as { error: { message: string } }).error.message).toContain(
      'invalid duration',
    );
    expect(calls.suspendRun).toEqual([]); // never reached a durable write
    expect(calls.reportStep).toEqual([]);
  });

  it('ctx.wait.until(new Date("x")) fails the run once, without a retry policy', async () => {
    const { kernel, calls } = fakeKernel();
    const ex = new Executor(kernel, taskWith(async (_p, ctx) => {
      await ctx.wait.until(new Date('x'));
    }), claimed(), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'failed' });
    expect(calls.failRun).toHaveLength(1);
    expect(calls.failRun[0]).toMatchObject({ abort: true, retry: undefined });
    expect((calls.failRun[0] as { error: { message: string } }).error.message).toContain(
      'Invalid time value',
    );
    expect(calls.suspendRun).toEqual([]);
  });

  it('an out-of-range duration (KernelError bad_request) is non-retryable too', async () => {
    const { kernel, calls } = fakeKernel();
    const ex = new Executor(kernel, taskWith(async (_p, ctx) => {
      await ctx.wait.for('999999999999w');
    }), claimed(), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'failed' });
    expect(calls.failRun).toHaveLength(1);
    expect(calls.failRun[0]).toMatchObject({ abort: true, retry: undefined });
    expect((calls.failRun[0] as { error: { message: string } }).error.message).toContain(
      'out of range',
    );
    expect(calls.suspendRun).toEqual([]);
  });

  it('a VALID wait still records a durable step (the guard does not swallow it)', async () => {
    const calls = { suspendRun: [] as unknown[] };
    const kernel = {
      suspendRun: async (input: unknown) => {
        calls.suspendRun.push(input);
        return { resumed: false };
      },
      appendLogs: async () => {},
    } as unknown as Kernel;
    const ex = new Executor(kernel, taskWith(async (_p, ctx) => {
      await ctx.wait.for('24h');
    }), claimed(), 'w1', null);

    // Suspends normally (SuspendSignal → 'suspended'), consuming seq 0.
    expect(await ex.execute()).toEqual({ type: 'suspended' });
    expect(calls.suspendRun).toHaveLength(1);
    expect((calls.suspendRun[0] as { seq: number }).seq).toBe(0);
  });
});
