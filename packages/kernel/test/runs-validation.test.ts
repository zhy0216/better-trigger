/* =============================================================================
   @better-trigger/kernel — createRunIn input validation tests.
   Everything POST /trigger and POST /batch-trigger accept funnels through
   createRunIn, which is therefore where a wrong-typed option has to be refused:
   the HTTP layer maps KernelError('bad_request') to 400, while a plain Error
   (parseDuration) or a value pg silently coerces (an object into a text column)
   would become a 500 or a corrupted row. The stub client answers the single
   tasks lookup these paths reach; no INSERT is ever attempted.
   ============================================================================= */
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { KernelError } from '@better-trigger/core';
import { createRunIn } from '../src/runs';

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

const create = (options: unknown) => {
  const { client, sqls } = makeClient();
  return {
    sqls,
    run: createRunIn(client, {
      taskId: 't',
      payload: null,
      options: options as never,
      triggerType: 'api',
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
    expect(sqls.some((s) => /ON CONFLICT \(task_id, idempotency_key\)/.test(s))).toBe(true);
  });

  it('keeps rejecting an out-of-range priority (unchanged)', async () => {
    await expectBadRequest({ priority: 2 ** 40 }, 'priority must be an int32');
    await expectBadRequest({ priority: '3' }, 'priority must be an int32');
  });
});
