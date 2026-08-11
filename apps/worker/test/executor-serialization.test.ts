/* =============================================================================
   @better-trigger/worker — C3 executor serialization unit tests.

   The executor computes the C1 replay fingerprint of a durable primitive's
   persistable inputs BEFORE the kernel is reached. A circular input (a child
   payload, a step option) would make canonicalStringify throw a TypeError —
   and a raw TypeError from inside user code gets classified as a retryable
   failure, burning attempts on a value that can never be recorded. The
   fingerprint method converts that into an AbortError instead (deterministic,
   non-retryable), and a BigInt child payload that reaches the kernel is
   converted the same way via the kernel's serialization_error. Exercised
   against recording fake kernels; no Postgres.
   ============================================================================= */
import type { ClaimedRun, LogEntry, RetryPolicy } from '@better-trigger/core';
import { AbortError, KernelError } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import type { ExecutorTask } from 'better-trigger/internal';
import { describe, expect, it } from 'vitest';
import { Executor } from '../src/executor';

function fakeKernel() {
  const calls = {
    waitForChildRun: [] as unknown[],
    batchTriggerChild: [] as unknown[],
    failRun: [] as unknown[],
    completeRun: [] as unknown[],
    reportStep: [] as unknown[],
  };
  const kernel = {
    waitForChildRun: async (input: unknown) => {
      calls.waitForChildRun.push(input);
      return { childRunId: 'child_1' };
    },
    batchTriggerChild: async (input: unknown) => {
      calls.batchTriggerChild.push(input);
      return { runIds: ['child_1'] };
    },
    failRun: async (input: unknown) => {
      calls.failRun.push(input);
    },
    completeRun: async (input: unknown) => {
      calls.completeRun.push(input);
    },
    reportStep: async (input: unknown) => {
      calls.reportStep.push(input);
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

const plainTask: ExecutorTask = { id: 'demo', run: async () => undefined };

describe('executor serialization (C3)', () => {
  it('a circular triggerAndWait payload fails as AbortError before the kernel is touched', async () => {
    const { kernel, calls } = fakeKernel();
    const ex = new Executor(kernel, plainTask, claimed(), 'w1', null);
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    await expect(ex.triggerAndWait('child', circular, 'wait-child')).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(calls.waitForChildRun).toEqual([]); // the fingerprint never produced a call
  });

  it('a circular batchTrigger item list fails as AbortError before the kernel is touched', async () => {
    const { kernel, calls } = fakeKernel();
    const ex = new Executor(kernel, plainTask, claimed(), 'w1', null);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      ex.durableBatchTrigger([{ taskId: 'child', payload: circular }], 'fan-out'),
    ).rejects.toBeInstanceOf(AbortError);
    expect(calls.batchTriggerChild).toEqual([]);
  });

  it('a circular step option inside a run fails the run non-retryably through execute()', async () => {
    const { kernel, calls } = fakeKernel();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const task: ExecutorTask = {
      id: 'demo',
      run: async (_payload, ctx) => {
        await ctx.step('work', () => 'x', {
          retry: circular as unknown as RetryPolicy,
        });
        return 'done';
      },
    };
    const ex = new Executor(kernel, task, claimed(), 'w1', null);

    expect(await ex.execute()).toEqual({ type: 'failed' });
    expect(calls.failRun).toHaveLength(1);
    expect(calls.failRun[0]).toMatchObject({ abort: true, retry: undefined });
    expect(calls.reportStep).toEqual([]); // never reached a kernel write
  });

  it('a BigInt child payload rejected by the kernel fails as AbortError (non-retryable)', async () => {
    const calls = { waitForChildRun: [] as unknown[] };
    const kernel = {
      waitForChildRun: async (input: unknown) => {
        calls.waitForChildRun.push(input);
        throw new KernelError(
          'serialization_error',
          'payload is not JSON-serializable: Do not know how to serialize a BigInt',
        );
      },
      reportStep: async () => {},
      appendLogs: async () => {},
    } as unknown as Kernel;
    const ex = new Executor(kernel, plainTask, claimed(), 'w1', null);

    await expect(ex.triggerAndWait('child', { n: 1n }, 'wait-child')).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(calls.waitForChildRun).toHaveLength(1); // BigInt fingerprints fine; the kernel refused it
  });
});
