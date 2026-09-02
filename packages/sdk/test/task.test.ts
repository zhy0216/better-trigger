/* =============================================================================
   better-trigger — task() normalization unit tests.

   task() is the only place a user's config is validated, and its output feeds
   two things that must agree: the registration manifest (what the daemon
   stores) and the executor task (what runs). Everything here is pure — no
   executor in the AsyncLocalStorage, so trigger paths are not exercised.
   ============================================================================= */
import { KernelError, type RetryPolicy, type TaskRunResult, type TriggerItem, type TriggerOptions, type WaitResult } from '@better-trigger/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { executorStorage, type RunExecutor } from '../src/context';
import type { RunCtx } from '../src/context';
import type { AnySchema } from '../src/schema';
import type { RunHandle } from '../src/instance';
import { normalizeCron, task, toExecutorTask, toManifest, unwrapResult } from '../src/task';

const noop = async (_payload: unknown, _ctx: RunCtx) => undefined;

/* p2-23: type-level fixtures for the trigger().result() output-type test.
   Everything here is compile-only (expectTypeOf with a type argument is a
   runtime no-op; the @ts-expect-error below is enforced by tsc --noEmit) —
   no instance is registered, so trigger()/result() are never invoked. */
const _typedResultTask = task('typed-result', async (_payload: { name: string }) => 'hello');
type TypedResultHandle = Awaited<ReturnType<typeof _typedResultTask.trigger>>;
type TypedResult = Awaited<ReturnType<TypedResultHandle['result']>>;

describe('normalizeCron', () => {
  it('passes undefined through', () => {
    expect(normalizeCron(undefined)).toBeUndefined();
  });

  it('wraps a bare pattern string, leaving timezone unset', () => {
    expect(normalizeCron('0 9 * * *')).toEqual({ pattern: '0 9 * * *' });
    expect(normalizeCron('0 9 * * *')?.timezone).toBeUndefined();
  });

  it('keeps pattern + timezone and drops anything else off the object', () => {
    const cron = normalizeCron({
      pattern: '*/5 * * * *',
      timezone: 'Asia/Shanghai',
      // extra keys must not survive into the manifest
      ...({ bogus: true } as object),
    });
    expect(cron).toEqual({ pattern: '*/5 * * * *', timezone: 'Asia/Shanghai' });
  });
});

describe('task(id, fn)', () => {
  it('keeps the id and the run function as given', () => {
    const handle = task('hello', noop);
    expect(handle.id).toBe('hello');
    expect(handle.__definition.id).toBe('hello');
    expect(handle.__definition.run).toBe(noop);
    expect(handle.__definition.retry).toBeUndefined();
    expect(handle.__definition.cron).toBeUndefined();
  });

  it('rejects a non-function second argument', () => {
    // @ts-expect-error — the whole point is the runtime guard
    expect(() => task('hello', 'not-a-fn')).toThrow(
      'task("hello", fn): second argument must be a function',
    );
  });
});

describe('task(config)', () => {
  it('normalizes cron and carries the optional metadata', () => {
    const handle = task({
      id: 'digest',
      name: 'Daily digest',
      description: 'sends the digest',
      filePath: 'src/tasks.ts',
      cron: '0 9 * * *',
      retry: { maxAttempts: 5 },
      replay: 'strict',
      concurrency: { limit: 2, key: (p: { userId: string }) => p.userId },
      run: async () => undefined,
    });

    const def = handle.__definition;
    expect(def.cron).toEqual({ pattern: '0 9 * * *' });
    expect(def.retry).toEqual({ maxAttempts: 5 });
    expect(def.replay).toBe('strict');
    expect(def.name).toBe('Daily digest');
    expect(def.description).toBe('sends the digest');
    expect(def.filePath).toBe('src/tasks.ts');
    expect(def.concurrency?.limit).toBe(2);
  });

  it('rejects a missing / empty / non-string id', () => {
    const message = 'task(config): "id" is required and must be a non-empty string';
    // @ts-expect-error — runtime guard
    expect(() => task({ run: noop })).toThrow(message);
    expect(() => task({ id: '', run: noop })).toThrow(message);
    // @ts-expect-error — runtime guard
    expect(() => task({ id: 42, run: noop })).toThrow(message);
  });

  it('rejects a non-function run', () => {
    // @ts-expect-error — runtime guard
    expect(() => task({ id: 'x', run: 'nope' })).toThrow('task("x"): "run" must be a function');
  });

  it('rejects a schema that does not implement Standard Schema', () => {
    // @ts-expect-error — runtime guard
    expect(() => task({ id: 'x', schema: {}, run: noop })).toThrow(/Standard Schema/);
  });

  it('rejects an unknown replay mode', () => {
    // @ts-expect-error — runtime guard
    expect(() => task({ id: 'x', replay: 'eventually', run: noop })).toThrow(
      `task("x"): "replay" must be 'lenient' or 'strict'`,
    );
    expect(() => task({ id: 'x', replay: 'lenient', run: noop })).not.toThrow();
    expect(() => task({ id: 'x', replay: 'strict', run: noop })).not.toThrow();
  });

  it('rejects an out-of-range retry policy at definition time (p1-16)', () => {
    const bad: Array<[string, Partial<RetryPolicy>]> = [
      ['NaN maxAttempts', { maxAttempts: NaN }],
      ['0 maxAttempts', { maxAttempts: 0 }],
      ['negative factor', { factor: -2 }],
      ['negative maxMs', { maxMs: -5 }],
    ];
    for (const [why, retry] of bad) {
      let err: unknown;
      try {
        // Well-typed on purpose: NaN / -2 are numbers — the range is the bug.
        task({ id: 'x', retry, run: noop });
      } catch (e) {
        err = e;
      }
      expect(err, why).toBeInstanceOf(KernelError);
      expect((err as KernelError).code, why).toBe('bad_request');
      expect((err as KernelError).message, why).toContain('task("x").retry');
    }
    expect(() => task({ id: 'x', retry: { maxAttempts: 5 }, run: noop })).not.toThrow();
  });
});

describe('toManifest', () => {
  it('emits only the id when nothing else is configured', () => {
    expect(toManifest(task('bare', noop).__definition)).toEqual({ id: 'bare' });
  });

  it('flattens concurrency.limit and omits the key function', () => {
    const def = task({
      id: 'keyed',
      concurrency: { limit: 3, key: (p: { id: string }) => p.id },
      run: async (_p: { id: string }) => undefined,
    }).__definition;

    const manifest = toManifest(def);
    expect(manifest).toEqual({ id: 'keyed', concurrencyLimit: 3 });
    expect('concurrency' in manifest).toBe(false);
  });

  it('carries cron / retry / metadata when present', () => {
    const def = task({
      id: 'full',
      name: 'Full',
      description: 'd',
      filePath: 'f.ts',
      cron: { pattern: '0 * * * *', timezone: 'UTC' },
      retry: { maxAttempts: 1 },
      run: async () => undefined,
    }).__definition;

    expect(toManifest(def)).toEqual({
      id: 'full',
      name: 'Full',
      description: 'd',
      filePath: 'f.ts',
      cron: { pattern: '0 * * * *', timezone: 'UTC' },
      retry: { maxAttempts: 1 },
    });
  });
});

describe('toExecutorTask', () => {
  it('leaves validate undefined when the task has no schema', () => {
    const executorTask = toExecutorTask(task('no-schema', noop).__definition);
    expect(executorTask.id).toBe('no-schema');
    expect(executorTask.run).toBe(noop);
    expect(executorTask.validate).toBeUndefined();
  });

  it('wires validate through the schema when one is given', async () => {
    const schema: AnySchema<number> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) =>
          typeof value === 'number' ? { value } : { issues: [{ message: 'not a number' }] },
      },
    };
    const executorTask = toExecutorTask(
      task({ id: 'schema', schema, run: async (_n: number) => undefined }).__definition,
    );

    await expect(executorTask.validate?.(7)).resolves.toBe(7);
    await expect(executorTask.validate?.('seven')).rejects.toThrow(
      'schema validation failed: not a number',
    );
  });
});

describe('unwrapResult', () => {
  it('returns the output of a successful child run', () => {
    expect(unwrapResult({ ok: true, id: 'run_1', output: 42 })).toBe(42);
  });

  it('rethrows a failed child run, preserving name and message', () => {
    const thrown = (() => {
      try {
        unwrapResult({
          ok: false,
          id: 'run_2',
          error: { message: 'child exploded', name: 'AbortError' },
        });
        return null;
      } catch (err) {
        return err as Error;
      }
    })();

    expect(thrown?.message).toBe('child exploded');
    expect(thrown?.name).toBe('AbortError');
  });

  it('falls back to a message naming the run id', () => {
    expect(() => unwrapResult({ ok: false, id: 'run_3' })).toThrow('child run run_3 failed');
  });
});

describe('trigger().result() output typing (p2-23)', () => {
  it('flows the task output type through trigger().result()', () => {
    // The handle's result() resolves with WaitResult<string> — the task's
    // TOutput — not WaitResult<unknown> (p2-23).
    expectTypeOf<TypedResultHandle>().toEqualTypeOf<RunHandle<string>>();
    expectTypeOf<TypedResult>().toEqualTypeOf<WaitResult<string>>();

    // Positive: a completed result whose output IS a string typechecks.
    const good: TypedResult = { status: 'completed', output: 'greeting' };
    expect(good.output).toBe('greeting');
  });

  it('rejects an output type that is not the task output', () => {
    // Compile-only: a non-string output must fail (unused @ts-expect-error
    // would itself error under tsc --noEmit).
    // @ts-expect-error — output must be the task's TOutput (string)
    const bad: TypedResult = { status: 'completed', output: 42 };
    expect(bad).toBeDefined();
  });
});

describe('batchTrigger per-item namespace narrowing (p1-15)', () => {
  const handle = task('typed-batch', noop);

  it('per-item env is a compile error', () => {
    // Compile-only: the assignment types `BatchItem[]`, never triggering HTTP.
    const items: Parameters<typeof handle.batchTrigger>[0] = [
      { payload: { n: 1 } },
      {
        payload: { n: 2 },
        // @ts-expect-error — per-item env would be silently dropped (p1-15)
        options: { env: 'staging' },
      },
    ];
    expect(items).toHaveLength(2);
  });

  it('per-item projectId is a compile error', () => {
    const items: Parameters<typeof handle.batchTrigger>[0] = [
      {
        payload: { n: 1 },
        // @ts-expect-error — per-item projectId would be silently dropped (p1-15)
        options: { projectId: 'acme' },
      },
    ];
    expect(items).toHaveLength(1);
  });

  it('batch-level env/projectId still typecheck (positive)', () => {
    // Compile-only: batchTrigger is never invoked, so no instance is needed.
    expect(handle.id).toBe('typed-batch');
    const args: Parameters<typeof handle.batchTrigger> = [
      [{ payload: { n: 1 } }],
      { env: 'staging', projectId: 'acme' },
    ];
    expect(args[0]).toHaveLength(1);
    expect(args[1]).toEqual({ env: 'staging', projectId: 'acme' });
  });
});

describe('durable in-run trigger — namespace warning (p1-15)', () => {
  const handle = task('durable-trigger', noop);

  it('warns and does not forward env/projectId to the durable batch step', async () => {
    const durableBatchTrigger = vi.fn(async (_items: TriggerItem[]) => ['run_child']);
    const executor: RunExecutor = {
      namespace: { projectId: 'default', env: 'prod' },
      durableBatchTrigger,
      triggerAndWait: vi.fn(
        async (_taskId: string, _payload: unknown, _label: string, _options?: TriggerOptions): Promise<TaskRunResult<never>> => ({
          id: 'run_child',
          ok: true,
          output: undefined as never,
        }),
      ),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warned: unknown[];
    try {
      await executorStorage()!.run(executor, async () => {
        await handle.trigger({ n: 1 }, { env: 'staging', projectId: 'acme' });
      });
      warned = warnSpy.mock.calls.map((c) => c[0]);
    } finally {
      warnSpy.mockRestore();
    }

    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/cannot change the namespace/);

    expect(durableBatchTrigger).toHaveBeenCalledTimes(1);
    const items = durableBatchTrigger.mock.calls[0]?.[0] as TriggerItem[];
    expect(items[0]?.taskId).toBe('durable-trigger');
    expect(items[0]?.payload).toEqual({ n: 1 });
    // env/projectId were warned about and stripped — the child inherits the
    // parent's namespace, and the pair must not poison the step fingerprint.
    expect(items[0]?.options).toEqual({});
  });

  it('triggerAndWait also strips env/projectId and warns', async () => {
    const triggerAndWait = vi.fn(
      async (_taskId: string, _p: unknown, _label: string, _o?: unknown): Promise<TaskRunResult<never>> => ({
        id: 'run_child',
        ok: true,
        output: undefined as never,
      }),
    );
    const executor: RunExecutor = {
      namespace: { projectId: 'default', env: 'prod' },
      durableBatchTrigger: vi.fn(async () => ['run_child']),
      triggerAndWait,
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warned: unknown[];
    try {
      await executorStorage()!.run(executor, async () => {
        const result = await handle.triggerAndWait({ n: 1 }, { env: 'staging' });
        expect(result.ok).toBe(true);
      });
      warned = warnSpy.mock.calls.map((c) => c[0]);
    } finally {
      warnSpy.mockRestore();
    }

    expect(warned).toHaveLength(1);
    expect(triggerAndWait).toHaveBeenCalledTimes(1);
    expect(triggerAndWait.mock.calls[0]?.[3]).toEqual({});
  });

  it('batchTrigger strips per-item env/projectId from the durable step items', async () => {
    // BatchItemOptions Omits env/projectId at the type level (p1-15), but a
    // non-typed caller's pair must not ride into the durable step fingerprint
    // either — replay drift for a value that is ignored anyway.
    const durableBatchTrigger = vi.fn(async (_items: TriggerItem[]) => ['run_1', 'run_2', 'run_3']);
    const executor: RunExecutor = {
      namespace: { projectId: 'default', env: 'prod' },
      durableBatchTrigger,
      triggerAndWait: vi.fn(),
    };
    const items = [
      { payload: { n: 1 }, options: { env: 'staging' } },
      { payload: { n: 2 }, options: { projectId: 'acme' } },
      { payload: { n: 3 }, options: { concurrencyKey: 'k3' } },
    ] as unknown as Parameters<typeof handle.batchTrigger>[0];

    await executorStorage()!.run(executor, async () => {
      await handle.batchTrigger(items);
    });

    expect(durableBatchTrigger).toHaveBeenCalledTimes(1);
    const stepItems = durableBatchTrigger.mock.calls[0]?.[0] as TriggerItem[];
    // The ignored namespace pair is gone from every item...
    expect(stepItems[0]?.options).toEqual({});
    expect(stepItems[1]?.options).toEqual({});
    // ...while legitimate per-item options ride along untouched.
    expect(stepItems[2]?.options).toEqual({ concurrencyKey: 'k3' });
  });
});
