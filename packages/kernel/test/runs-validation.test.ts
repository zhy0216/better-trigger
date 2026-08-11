/* =============================================================================
   @better-trigger/kernel — createRunIn input validation tests.
   Everything POST /trigger and POST /batch-trigger accept funnels through
   createRunIn, which is therefore where a wrong-typed option has to be refused:
   the HTTP layer maps KernelError('bad_request') to 400, while a plain Error
   (parseDuration) or a value pg silently coerces (an object into a text column)
   would become a 500 or a corrupted row. The stub client answers the single
   tasks lookup these paths reach; no INSERT is ever attempted.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError } from '@better-trigger/core';
import { batchTrigger, createRunIn } from '../src/runs';

/** Answers the `SELECT ... FROM tasks` lookup and records every statement. */
const makeClient = () => {
  const sqls: string[] = [];
  const client = {
    query: async (sql: string) => {
      sqls.push(sql);
      return {
        rows: [{ id: 't', retry: null, concurrency_limit: null, latest_code_version: null }],
      };
    },
  } as unknown as PoolClient;
  return { client, sqls };
};

const create = (options: unknown, payload: unknown = null) => {
  const { client, sqls } = makeClient();
  return {
    sqls,
    run: createRunIn(client, {
      taskId: 't',
      payload,
      options: options as never,
      triggerType: 'api',
      namespace: DEFAULT_NAMESPACE,
    }),
  };
};

/** Asserts the call rejects with bad_request and never got as far as INSERT. */
const expectBadRequest = async (options: unknown, message?: string) => {
  const { run, sqls } = create(options);
  await expect(run).rejects.toBeInstanceOf(KernelError);
  await run.catch((err: KernelError) => {
    expect(err.code).toBe('bad_request');
    if (message) expect(err.message).toBe(message);
  });
  expect(sqls.some((s) => /INSERT/.test(s))).toBe(false);
};

describe('createRunIn option validation', () => {
  it('rejects a non-object options', async () => {
    for (const options of ['prod', 42, []]) {
      await expectBadRequest(options, 'options must be an object');
    }
  });

  it('rejects an unparseable delay instead of throwing a plain Error', async () => {
    for (const delay of ['soon', '10 potatoes', {}, true, -1]) {
      await expectBadRequest({ delay }, 'delay must be ms or a duration like "10m"');
    }
  });

  it('still accepts the documented delay spellings', async () => {
    // Reaching the INSERT is proof enough that validation let the value through.
    const { run, sqls } = create({ delay: '10m' });
    await run.catch(() => {});
    expect(sqls.some((s) => /INSERT INTO runs/.test(s))).toBe(true);

    const ms = create({ delay: 5_000 });
    await ms.run.catch(() => {});
    expect(ms.sqls.some((s) => /INSERT INTO runs/.test(s))).toBe(true);
  });

  it('rejects text options that are not text', async () => {
    await expectBadRequest({ idempotencyKey: { a: 1 } }, 'idempotencyKey must be a string');
    await expectBadRequest({ concurrencyKey: 7 }, 'concurrencyKey must be a string');
    await expectBadRequest({ env: ['prod'] }, 'env must be a string');
  });

  it('rejects empty text options before they reach the INSERT', async () => {
    // '' is falsy but non-null, so it used to pass the type check and then split
    // the two reads of the key: the plain (no ON CONFLICT) INSERT branch was
    // chosen on truthiness while `?? null` still bound '' as a non-NULL value.
    // The second such trigger therefore violated the partial unique index
    // runs_task_idempotency_uniq (task_id, idempotency_key) WHERE
    // idempotency_key IS NOT NULL — a raw pg 23505, not a KernelError, so
    // app.onError logged "unhandled error" and answered 500.
    await expectBadRequest({ idempotencyKey: '' }, 'idempotencyKey must not be empty');
    await expectBadRequest({ concurrencyKey: '' }, 'concurrencyKey must not be empty');
    await expectBadRequest({ env: '' }, 'env must not be empty');
  });

  it('still accepts non-empty text options', async () => {
    const { run, sqls } = create({ idempotencyKey: 'k', concurrencyKey: 'c', env: 'staging' });
    await run.catch(() => {});
    // The idempotent branch is the one with the conflict target.
    expect(
      sqls.some((s) => /ON CONFLICT \(project_id, env, task_id, idempotency_key\)/.test(s)),
    ).toBe(true);
  });

  it('keeps rejecting an out-of-range priority (unchanged)', async () => {
    await expectBadRequest({ priority: 2 ** 40 }, 'priority must be an int32');
    await expectBadRequest({ priority: '3' }, 'priority must be an int32');
  });
});

/* ---------------------------------------------------------------------------
 * Size limits (S4)
 * ------------------------------------------------------------------------- */

/** A pool that proves the caller never opened a transaction. */
const sentinel = new Error('connect() reached');
const refusingPool = {
  connect: async () => {
    throw sentinel;
  },
} as unknown as Pool;

const item = { taskId: 't', payload: null };

afterEach(() => {
  delete process.env.BETTER_TRIGGER_MAX_BATCH;
  delete process.env.BETTER_TRIGGER_MAX_PAYLOAD_BYTES;
});

describe('batchTrigger item cap', () => {
  it('rejects more than 500 items before opening a transaction', async () => {
    const items = Array.from({ length: 501 }, () => item);
    // bad_request is what app.ts maps to 400 — the point of the whole check is
    // that 501 items is the caller's mistake, not a dead daemon and a 500.
    await expect(batchTrigger(refusingPool, items, DEFAULT_NAMESPACE)).rejects.toMatchObject({
      code: 'bad_request',
      message: 'items must contain at most 500 entries (split larger fan-outs into batches)',
    });
    await expect(batchTrigger(refusingPool, items, DEFAULT_NAMESPACE)).rejects.toBeInstanceOf(KernelError);
  });

  it('lets a batch at the cap through untouched', async () => {
    // Reaching connect() is proof the guard passed; the sentinel stands in for
    // the transaction we do not want to run here.
    await expect(
      batchTrigger(refusingPool, Array.from({ length: 500 }, () => item), DEFAULT_NAMESPACE),
    ).rejects.toBe(sentinel);
    await expect(batchTrigger(refusingPool, [item], DEFAULT_NAMESPACE)).rejects.toBe(sentinel);
  });

  it('treats an empty batch as a no-op that never reaches the database (PF5)', async () => {
    // An empty VALUES list would be a syntax error inside the tx; the entry
    // guard returns the empty result instead — no connect, no statements.
    await expect(batchTrigger(refusingPool, [], DEFAULT_NAMESPACE)).resolves.toEqual({
      runIds: [],
    });
  });

  it('honours BETTER_TRIGGER_MAX_BATCH', async () => {
    process.env.BETTER_TRIGGER_MAX_BATCH = '2';
    await expect(batchTrigger(refusingPool, [item, item, item], DEFAULT_NAMESPACE)).rejects.toMatchObject({
      code: 'bad_request',
      message: 'items must contain at most 2 entries (split larger fan-outs into batches)',
    });
    await expect(batchTrigger(refusingPool, [item, item], DEFAULT_NAMESPACE)).rejects.toBe(sentinel);
  });

  it('falls back to the default when the env value is garbage', async () => {
    for (const raw of ['0', '-5', 'many', '1.5']) {
      process.env.BETTER_TRIGGER_MAX_BATCH = raw;
      await expect(batchTrigger(refusingPool, [item, item], DEFAULT_NAMESPACE)).rejects.toBe(sentinel);
    }
  });
});

describe('payload size cap', () => {
  /** Serializes to a little over `bytes` (the quotes add two). */
  const blob = (bytes: number) => 'x'.repeat(bytes);

  it('rejects a payload over 256KB before it reaches pg', async () => {
    const { run, sqls } = create({}, blob(256 * 1024));
    await expect(run).rejects.toBeInstanceOf(KernelError);
    await run.catch((err: KernelError) => {
      // payload_too_large (413), not bad_request (400): the same stable code
      // family the HTTP body cap uses — "you sent too much" is one error (C3).
      expect(err.code).toBe('payload_too_large');
      expect(err.message).toMatch(/payload must serialize to at most 262144 bytes/);
    });
    // Not even the tasks lookup — the check runs before the first query.
    expect(sqls).toEqual([]);
  });

  it('still accepts a payload under the cap', async () => {
    const { run, sqls } = create({}, { note: blob(1000) });
    await run.catch(() => {});
    expect(sqls.some((s) => /INSERT INTO runs/.test(s))).toBe(true);
  });

  it('honours BETTER_TRIGGER_MAX_PAYLOAD_BYTES', async () => {
    process.env.BETTER_TRIGGER_MAX_PAYLOAD_BYTES = '16';
    const small = create({}, blob(64));
    await expect(small.run).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(small.sqls).toEqual([]);

    const ok = create({}, 'x');
    await ok.run.catch(() => {});
    expect(ok.sqls.some((s) => /INSERT INTO runs/.test(s))).toBe(true);
  });

  it('measures bytes, not characters', async () => {
    // 3 bytes per char in UTF-8: 100 chars is 300 bytes, past a 128-byte cap
    // that a naive .length check would have let through.
    process.env.BETTER_TRIGGER_MAX_PAYLOAD_BYTES = '128';
    const { run, sqls } = create({}, '中'.repeat(100));
    await expect(run).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(sqls).toEqual([]);
  });
});
