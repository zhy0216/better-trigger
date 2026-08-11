/* =============================================================================
   @better-trigger/worker — C1 replay fingerprint unit tests.
   The executor replays completed step rows only when the call site's
   fingerprint (kind + label + persistable inputs + code version) matches the
   recorded one. A non-NULL mismatch is ALWAYS a non-retryable failure — there
   is no lenient reading of "the recorded output belongs to different code or
   inputs" — while a NULL fingerprint (pre-fingerprint ledger) replays leniently
   with one compat notice. Waits fingerprint their DECLARED duration/instant,
   not the recomputed absolute resumeAt, so a normal suspend→resume→replay
   cycle never drifts. Exercised against a recording fake kernel (no Postgres).
   ============================================================================= */
import type { ClaimedRun, LogEntry, StepSnapshot } from '@better-trigger/core';
import { NonDeterminismError } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import { fnSourceHash, stepFingerprint } from '@better-trigger/kernel';
import type { ExecutorTask } from 'better-trigger/internal';
import { describe, expect, it } from 'vitest';
import { Executor } from '../src/executor';

/** Records every write the executor attempts; all of them succeed. */
function fakeKernel() {
  const calls = {
    reportStep: [] as any[],
    failRun: [] as any[],
    completeRun: [] as any[],
    suspendRun: [] as any[],
    waitForChildRun: [] as any[],
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
    waitForChildRun: async (input: any) => {
      calls.waitForChildRun.push(input);
      return { childRunId: 'child_1' };
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

/** Call-site fingerprint for a ctx.step with this label + fn + null code version. */
const stepFp = (label: string, fn: () => unknown) =>
  stepFingerprint({
    kind: 'step',
    label,
    input: { fn: fnSourceHash(fn) },
    codeVersion: null,
  });

const original = () => 'original output';
const edited = () => 'edited output';

const plainTask: ExecutorTask = { id: 'demo', run: async () => undefined };

const warnLogs = (logs: LogEntry[]): string[] =>
  logs.filter((l) => l.level === 'warn').map((l) => l.message);

/** Assert the run failed non-retryably with a fingerprint message. */
function expectFingerprintFail(calls: { failRun: any[] }, message: string) {
  expect(calls.failRun).toHaveLength(1);
  expect(calls.failRun[0].abort).toBe(true); // retrying replays the same mismatch
  expect(calls.failRun[0].retry).toBeUndefined();
  expect(calls.failRun[0].error.message).toContain(message);
}

describe('replay fingerprints (C1)', () => {
  it('replays a memoized step whose fingerprint still matches', async () => {
    const { kernel, calls } = fakeKernel();
    const task: ExecutorTask = {
      id: 'demo',
      run: (_payload, ctx) => ctx.step('memoized', original),
    };
    const snapshot: StepSnapshot[] = [
      { seq: 0, kind: 'step', label: 'memoized', status: 'completed', output: 'old', fingerprint: stepFp('memoized', original) },
    ];
    const ex = new Executor(kernel, task, claimed(snapshot), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'completed', output: 'old' });
    expect(calls.reportStep).toEqual([]); // never re-executed
    expect(calls.completeRun).toHaveLength(1);
    expect(warnLogs(calls.logs)).toEqual([]); // a stable ledger replays silently
  });

  it('same label, changed fn → fails non-retryably even under default (lenient) replay', async () => {
    const { kernel, calls } = fakeKernel();
    const task: ExecutorTask = {
      id: 'demo',
      run: (_payload, ctx) => ctx.step('memoized', edited),
    };
    const snapshot: StepSnapshot[] = [
      { seq: 0, kind: 'step', label: 'memoized', status: 'completed', output: 'old', fingerprint: stepFp('memoized', original) },
    ];
    const ex = new Executor(kernel, task, claimed(snapshot), 'w1', null);

    // The recorded output belongs to different code: no lenient reading of it —
    // the run must never return the old step output to the edited code.
    expect(await ex.execute()).toEqual({ type: 'failed' });
    expectFingerprintFail(calls, 'replay fingerprint mismatch');
    expect(calls.reportStep).toEqual([]); // the recorded row is never touched
    expect(calls.completeRun).toEqual([]);
  });

  it('reports completed steps with the fingerprint of their call site', async () => {
    const { kernel, calls } = fakeKernel();
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        await ctx.step('work', original);
        await ctx.now();
        return 'done';
      },
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'completed', output: 'done' });
    expect(calls.reportStep).toHaveLength(2);
    expect(calls.reportStep[0].fingerprint).toBe(stepFp('work', original));
    expect(calls.reportStep[1].fingerprint).toBe(
      stepFingerprint({ kind: 'now', label: null, input: {}, codeVersion: null }),
    );
  });

  it('a NULL fingerprint (pre-fingerprint ledger) replays leniently with one compat notice', async () => {
    const { kernel, calls } = fakeKernel();
    const task: ExecutorTask = {
      id: 'demo',
      run: (_payload, ctx) => ctx.step('legacy', edited),
    };
    const snapshot: StepSnapshot[] = [
      { seq: 0, kind: 'step', label: 'legacy', status: 'completed', output: 'old', fingerprint: null },
    ];
    const ex = new Executor(kernel, task, claimed(snapshot), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'completed', output: 'old' });
    const warns = warnLogs(calls.logs);
    expect(warns.some((m) => m.includes('recorded before replay fingerprints'))).toBe(true);
    expect(calls.reportStep).toEqual([]);
  });

  it('ctx.wait.for fingerprints the DECLARED duration, so a suspend→resume→replay cycle never drifts', async () => {
    const { kernel, calls } = fakeKernel();
    const declared = '2h';
    const declaredFp = stepFingerprint({
      kind: 'wait',
      label: null,
      input: { duration: declared },
      codeVersion: null,
    });
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        await ctx.wait.for(declared);
        return 'waited';
      },
    };

    // Pass 1 — the wait suspends; suspendRun receives the DECLARED fingerprint.
    const ex1 = new Executor(kernel, task, claimed(), 'w1', null);
    expect(await ex1.execute()).toEqual({ type: 'suspended' });
    expect(calls.suspendRun).toHaveLength(1);
    expect(calls.suspendRun[0].fingerprint).toBe(declaredFp);
    expect(calls.suspendRun[0].resumeAt).not.toBe(declared); // absolute instant, but...

    // Pass 2 — the orchestrator stamped the completed row with the waits
    // fingerprint (declaredFp); the replay recomputes the SAME declared
    // fingerprint and hits, even though the wall-clock resumeAt has moved on.
    const snapshot: StepSnapshot[] = [
      { seq: 0, kind: 'wait', label: null, status: 'completed', output: null, fingerprint: declaredFp },
    ];
    const ex2 = new Executor(kernel, task, claimed(snapshot), 'w1', null);
    expect(await ex2.execute()).toEqual({ type: 'completed', output: 'waited' });
    expect(calls.suspendRun).toHaveLength(1); // second pass never suspends again
    expect(warnLogs(calls.logs)).toEqual([]);
  });

  it('ctx.wait.until fingerprints the declared instant and replays it', async () => {
    const { kernel, calls } = fakeKernel();
    const resumeAt = new Date('2030-01-01T00:00:00.000Z');
    const untilFp = stepFingerprint({
      kind: 'wait',
      label: null,
      input: { until: resumeAt.toISOString() },
      codeVersion: null,
    });
    const task: ExecutorTask = {
      id: 'demo',
      run: (_payload, ctx) => ctx.wait.until(resumeAt),
    };
    const snapshot: StepSnapshot[] = [
      { seq: 0, kind: 'wait', label: null, status: 'completed', output: null, fingerprint: untilFp },
    ];
    const ex = new Executor(kernel, task, claimed(snapshot), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'completed', output: undefined });
    expect(calls.reportStep).toEqual([]);
    expect(calls.completeRun).toHaveLength(1);
  });

  it("a resumed wait whose declared duration changed fails non-retryably", async () => {
    const { kernel, calls } = fakeKernel();
    const oldFp = stepFingerprint({
      kind: 'wait',
      label: null,
      input: { duration: '2h' },
      codeVersion: null,
    });
    const task: ExecutorTask = {
      id: 'demo',
      run: (_payload, ctx) => ctx.wait.for('4h'),
    };
    const snapshot: StepSnapshot[] = [
      { seq: 0, kind: 'wait', label: null, status: 'completed', output: null, fingerprint: oldFp },
    ];
    const ex = new Executor(kernel, task, claimed(snapshot), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'failed' });
    expectFingerprintFail(calls, 'replay fingerprint mismatch');
  });

  it('triggerAndWait fingerprints taskId + payload + options and persists it on the wait', async () => {
    const { kernel, calls } = fakeKernel();
    const options = { priority: 5, idempotencyKey: 'k1' };
    const expectedFp = stepFingerprint({
      kind: 'trigger-and-wait',
      label: null,
      input: { taskId: 'child', payload: { n: 1 }, options },
      codeVersion: null,
    });
    const ex = new Executor(kernel, plainTask, claimed(), 'w1', null);

    // Pass 1 — suspends; waitForChildRun receives the options-bearing fingerprint.
    await expect(ex.triggerAndWait('child', { n: 1 }, 'wait-child', options)).rejects.toMatchObject({
      isBetterTriggerSuspend: true,
    });
    expect(calls.waitForChildRun).toHaveLength(1);
    expect(calls.waitForChildRun[0].fingerprint).toBe(expectedFp);

    // Pass 2 — a completed row written with that fingerprint replays silently.
    const snapshot: StepSnapshot[] = [
      {
        seq: 0,
        kind: 'trigger-and-wait',
        label: 'wait-child',
        status: 'completed',
        output: { id: 'child_1', ok: true },
        fingerprint: expectedFp,
      },
    ];
    const ex2 = new Executor(kernel, plainTask, claimed(snapshot), 'w1', null);
    await expect(ex2.triggerAndWait('child', { n: 1 }, 'wait-child', options)).resolves.toEqual({
      id: 'child_1',
      ok: true,
    });
    expect(calls.waitForChildRun).toHaveLength(1); // hit — no new wait
  });

  it('triggerAndWait with changed options fails non-retryably on replay', async () => {
    const { kernel, calls } = fakeKernel();
    const oldFp = stepFingerprint({
      kind: 'trigger-and-wait',
      label: null,
      input: { taskId: 'child', payload: { n: 1 }, options: { priority: 5 } },
      codeVersion: null,
    });
    const snapshot: StepSnapshot[] = [
      {
        seq: 0,
        kind: 'trigger-and-wait',
        label: 'wait-child',
        status: 'completed',
        output: { id: 'child_1', ok: true },
        fingerprint: oldFp,
      },
    ];
    const ex = new Executor(kernel, plainTask, claimed(snapshot), 'w1', null);
    await expect(
      ex.triggerAndWait('child', { n: 1 }, 'wait-child', { priority: 9 }),
    ).rejects.toThrow(/replay fingerprint mismatch/);
    expect(calls.waitForChildRun).toEqual([]);
  });

  it('turns a kernel NonDeterminismError into a non-retryable failure', async () => {
    const calls = { failRun: [] as any[] };
    const kernel = {
      reportStep: async () => {
        throw new NonDeterminismError(
          'step fingerprint mismatch at run run_1 seq 0 (kind \'step\', label "work")',
        );
      },
      failRun: async (input: any) => {
        calls.failRun.push(input);
      },
      completeRun: async () => {},
      appendLogs: async () => {},
    } as unknown as Kernel;
    const task: ExecutorTask = {
      id: 'demo',
      run: (_payload, ctx) => ctx.step('work', () => 'fresh'),
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'failed' });
    expectFingerprintFail(calls, 'fingerprint mismatch');
  });
});
