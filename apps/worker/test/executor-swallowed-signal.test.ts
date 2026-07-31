/* =============================================================================
   @better-trigger/worker — swallowed control-flow signals (todos C6).

   Suspending (SuspendSignal) and ending an attempt (ExecutionDone) are thrown
   into user code, and `try { await ctx.wait.for('1h') } catch {}` is perfectly
   legal TypeScript that keeps executing afterwards — with the run already
   'waiting'. These tests pin the detection: the next durable primitive fails
   with an AbortError that names the mistake, a warn lands in the run's own logs
   (so it is visible where the user looks), and nothing is completed behind the
   run's back. Recording fake kernel, no Postgres — same shape as
   executor-signal.test.ts.
   ============================================================================= */
import { isAbortError, type ClaimedRun, type LogEntry } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import type { ExecutorTask } from 'better-trigger/internal';
import { describe, expect, it } from 'vitest';
import { Executor } from '../src/executor';

/** Records every write; suspendRun always really suspends. */
function fakeKernel() {
  const calls = {
    reportStep: [] as any[],
    failRun: [] as any[],
    completeRun: [] as any[],
    suspendRun: [] as any[],
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
    suspendRun: async (input: any) => {
      calls.suspendRun.push(input);
      return { resumed: false };
    },
    appendLogs: async (_runId: string, logs: LogEntry[]) => {
      calls.logs.push(...logs);
    },
  } as unknown as Kernel;
  return { kernel, calls };
}

const claimed = (): ClaimedRun => ({
  id: 'run_1',
  taskId: 'demo',
  payload: { n: 1 },
  attempt: 1,
  maxAttempts: 3,
  codeVersion: null,
  env: 'dev',
  steps: [],
  fencingToken: 7,
});

const warns = (logs: LogEntry[]) => logs.filter((l) => l.level === 'warn');

describe('swallowed suspend signal', () => {
  it('fails the next durable primitive with an explicit AbortError', async () => {
    const { kernel, calls } = fakeKernel();
    let caught: any;
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        try {
          await ctx.wait.for('1h');
        } catch {
          /* the mistake C6 is about */
        }
        try {
          // The "sendEmail" stand-in: a real side effect after the suspend.
          await ctx.step('send-email', () => 'sent');
        } catch (err) {
          caught = err;
          throw err;
        }
        return 'never';
      },
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    const result = await ex.execute();

    expect(calls.suspendRun).toHaveLength(1); // the run really is 'waiting'
    expect(isAbortError(caught)).toBe(true);
    expect(caught.message).toContain('ctx.step("send-email")');
    expect(caught.message).toContain('caught the suspend signal');
    // The step after the swallowed signal is never recorded (it must not be).
    expect(calls.reportStep).toEqual([]);
    expect(calls.completeRun).toEqual([]);
    // Non-retryable: replaying the same code would swallow the signal again.
    // (Against the real kernel this failRun lands on a run that is already
    // 'waiting', so assertOwnedRunning rejects it with run_not_running and the
    // outcome is 'abandoned' — the run just resumes an hour later. The fake
    // accepts every write, so what is pinned here is the intent: abort:true,
    // never a retry, and nothing completed behind the run's back.)
    expect(result).toEqual({ type: 'failed' });
    expect(calls.failRun).toHaveLength(1);
    expect(calls.failRun[0].abort).toBe(true);
  });

  it('writes the warning into the run logs, not just the console', async () => {
    const { kernel, calls } = fakeKernel();
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        try {
          await ctx.wait.for('1h');
        } catch {
          /* swallowed */
        }
        await ctx.step('send-email', () => 'sent');
        return 'never';
      },
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);
    await ex.execute();

    const warned = warns(calls.logs);
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toContain('caught the suspend signal');
    expect(warned[0].message).toContain('runs again when the run replays');
  });

  it('does not complete a suspended run when run() returns after the catch', async () => {
    const { kernel, calls } = fakeKernel();
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        try {
          await ctx.wait.for('1h');
        } catch {
          /* swallowed, and no durable primitive follows */
        }
        return 'bogus output';
      },
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    // The run is waiting: its outcome is 'suspended', whatever run() returned.
    expect(await ex.execute()).toEqual({ type: 'suspended' });
    expect(calls.completeRun).toEqual([]);
    expect(calls.failRun).toEqual([]);
    expect(warns(calls.logs)[0]?.message).toContain('caught the suspend signal');
  });

  it('still delivers the warning when the attempt is abandoned on the way out', async () => {
    // The abandonment paths return from handleThrown WITHOUT flushing (nothing
    // this attempt says can be recorded anymore, so there is no failRun to
    // carry the buffer out). That is why assertSignalNotSwallowed flushes on
    // its own: here the heartbeat reports the claim gone while user code is in
    // its swallow-and-keep-going stretch, and this warn is the only trace the
    // user will ever get of why their "sent" email has no step row.
    const { kernel, calls } = fakeKernel();
    let ex!: Executor;
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        try {
          await ctx.wait.for('1h');
        } catch {
          /* swallowed */
        }
        ex.markLost(); // heartbeat: this claim was reaped away
        await ctx.step('send-email', () => 'sent');
        return 'never';
      },
    };
    ex = new Executor(kernel, task, claimed(), 'w1', null);

    // No failRun, no completeRun — the outcome is reported to nobody...
    expect(await ex.execute()).toEqual({ type: 'abandoned' });
    expect(calls.failRun).toEqual([]);
    expect(calls.completeRun).toEqual([]);
    // ...and yet the warning made it to the run's logs.
    expect(warns(calls.logs)[0]?.message).toContain('caught the suspend signal');
  });

  it('rethrowing the suspend signal keeps the normal suspend path', async () => {
    const { kernel, calls } = fakeKernel();
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        try {
          await ctx.wait.for('1h');
        } catch (err) {
          throw err; // what the docs ask for
        }
        return 'after the wait';
      },
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'suspended' });
    expect(warns(calls.logs)).toEqual([]);
    expect(calls.failRun).toEqual([]);
  });
});

describe('swallowed end-of-execution signal', () => {
  /** Step 1 fails; user code swallows the unwind and keeps calling primitives. */
  const swallowFailure = (after: (ctx: any) => Promise<unknown>): ExecutorTask => ({
    id: 'demo',
    run: async (_payload, ctx) => {
      try {
        await ctx.step('boom', () => {
          throw new Error('step failed');
        });
      } catch {
        /* swallows ExecutionDone, not the step error: the run already failed */
      }
      return after(ctx);
    },
  });

  it('fails a later durable primitive with an explicit AbortError', async () => {
    const { kernel, calls } = fakeKernel();
    let caught: any;
    const task = swallowFailure(async (ctx) => {
      try {
        await ctx.step('second', () => 'nope');
      } catch (err) {
        caught = err;
        throw err;
      }
    });
    const ex = new Executor(kernel, task, claimed(), 'w1', null);
    await ex.execute();

    expect(isAbortError(caught)).toBe(true);
    expect(caught.message).toContain('caught the internal end-of-execution signal');
    expect(warns(calls.logs)[0]?.message).toContain('end-of-execution signal');
    // Only the failed 'boom' row exists; 'second' never ran against the kernel.
    expect(calls.reportStep).toHaveLength(1);
    expect(calls.reportStep[0].label).toBe('boom');
  });

  it('does not complete a failed run when run() returns after the catch', async () => {
    const { kernel, calls } = fakeKernel();
    const task = swallowFailure(async () => 'looks fine to me');
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'failed' });
    expect(calls.completeRun).toEqual([]);
    expect(calls.failRun).toHaveLength(1); // the original step failure, once
  });
});

describe('every durable primitive is guarded', () => {
  // ctx.step / ctx.wait are covered in detail above; the remaining three entry
  // points share the same assertSignalNotSwallowed call, so one case each is
  // enough to catch an entry point that forgets to make it.
  const entries = [
    [
      'triggerAndWait',
      (ex: Executor) => ex.triggerAndWait('child', {}, 'child'),
      'triggerAndWait("child")',
    ],
    [
      'trigger/batchTrigger',
      (ex: Executor) => ex.durableBatchTrigger([], 'fanout'),
      'trigger/batchTrigger (fanout)',
    ],
    ['ctx.now', (_ex: Executor, ctx: any) => ctx.now(), 'ctx.now()'],
  ] as const;

  it.each(entries)('%s refuses to run after a swallowed signal', async (_name, call, named) => {
    const { kernel, calls } = fakeKernel();
    let ex!: Executor;
    let caught: any;
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        try {
          await ctx.wait.for('1h');
        } catch {
          /* swallowed */
        }
        try {
          await call(ex, ctx);
        } catch (err) {
          caught = err;
          throw err;
        }
        return 'never';
      },
    };
    ex = new Executor(kernel, task, claimed(), 'w1', null);
    await ex.execute();

    expect(isAbortError(caught)).toBe(true);
    expect(caught.message).toContain(named);
    // ctx.now() would otherwise happily record a row on a suspended run.
    expect(calls.reportStep).toEqual([]);
    expect(calls.completeRun).toEqual([]);
  });
});
