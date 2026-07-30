/* =============================================================================
   better-trigger — task() normalization unit tests.

   task() is the only place a user's config is validated, and its output feeds
   two things that must agree: the registration manifest (what the daemon
   stores) and the executor task (what runs). Everything here is pure — no
   executor in the AsyncLocalStorage, so trigger paths are not exercised.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import type { RunCtx } from '../src/context';
import type { AnySchema } from '../src/schema';
import { normalizeCron, task, toExecutorTask, toManifest, unwrapResult } from '../src/task';

const noop = async (_payload: unknown, _ctx: RunCtx) => undefined;

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
