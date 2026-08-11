/* =============================================================================
   @better-trigger/kernel — batchTrigger round-trip behaviour (PF5,
   todos/02-performance.md).

   batchTrigger used to walk createRunIn per item: 500 items meant ~500 task
   lookups + 500 runs INSERTs + 500 queue INSERTs inside one long transaction.
   The fixed path preloads the (deduplicated) task configs in one SELECT and
   inserts runs and queue rows with one multi-row statement each, so the
   statement count is constant in the item count. This file pins that with a
   stub client that SIMULATES the idempotency index (stateful across calls,
   like the real database): an INSERT whose (task_id, idempotency_key) is
   already present returns no row, and the follow-up readback answers it.

   No Postgres. The stub records every statement + its parameters, so "how
   many round trips" and "which values landed on which row" are both
   assertable directly.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, KernelError, TaskNotFoundError, type TriggerItem } from '@better-trigger/core';
import { batchTrigger } from '../src/runs';

interface Stmt {
  sql: string;
  params: unknown[];
}

interface TaskRow {
  id: string;
  retry: unknown;
  concurrency_limit: number | null;
  latest_code_version: string | null;
}

/**
 * A pool whose single client plays the parts of the database the batch path
 * touches:
 *   - the task preload answers from `tasks` (a row per known id);
 *   - the runs INSERT returns a row per VALUES tuple whose
 *     (task_id, idempotency_key) is not yet in `insertedKeys` — same-batch
 *     duplicates and repeats of earlier keys conflict, exactly like the
 *     partial unique index runs_task_idempotency_uniq;
 *   - the conflict readback returns the stored id for the pairs that exist.
 * Every statement lands in `stmts` (tx bookkeeping included, for the
 * "last statement is the notify" style assertions).
 */
const makePool = (tasks: TaskRow[]) => {
  const stmts: Stmt[] = [];
  const insertedKeys = new Map<string, string>(); // `${taskId}\u0000${key}` → id
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/pg_notify/.test(sql)) return { rows: [] };
      if (/FROM tasks/.test(sql)) {
        // Params: projectId, env, id per task — ids at index 2 of each triple.
        const ids: string[] = [];
        for (let i = 2; i < params.length; i += 3) ids.push(String(params[i]));
        return {
          rows: ids
            .map((id) => taskMap.get(id))
            .filter((t): t is TaskRow => t !== undefined),
        };
      }
      if (/INSERT INTO runs/.test(sql)) {
        const rows: { id: string }[] = [];
        for (let i = 0; i < params.length; i += 13) {
          const taskId = String(params[i + 3]);
          const key = params[i + 7];
          const id = String(params[i]);
          const pair = key == null ? null : `${taskId}\u0000${String(key)}`;
          if (pair !== null && insertedKeys.has(pair)) continue; // conflict
          if (pair !== null) insertedKeys.set(pair, id);
          rows.push({ id });
        }
        return { rows };
      }
      if (/INSERT INTO queue/.test(sql)) return { rows: [] };
      if (/idempotency_key.*IN \(VALUES/.test(sql)) {
        // The conflict readback: params are projectId, env, taskId, key per
        // pair — 4 per tuple.
        const rows: { id: string; task_id: string; idempotency_key: string }[] = [];
        for (let i = 0; i < params.length; i += 4) {
          const taskId = String(params[i + 2]);
          const key = String(params[i + 3]);
          const id = insertedKeys.get(`${taskId}\u0000${key}`);
          if (id !== undefined) rows.push({ id, task_id: taskId, idempotency_key: key });
        }
        return { rows };
      }
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, stmts };
};

/** Statements excluding tx bookkeeping (BEGIN/COMMIT/ROLLBACK). */
const dataStmts = (stmts: Stmt[]): Stmt[] =>
  stmts.filter((s) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(s.sql));

const findByKind = (stmts: Stmt[], re: RegExp): Stmt[] => stmts.filter((s) => re.test(s.sql));

const TASK = (id: string, concurrencyLimit: number | null = null): TaskRow => ({
  id,
  retry: null,
  concurrency_limit: concurrencyLimit,
  latest_code_version: null,
});

const items = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));

afterEach(() => {
  delete process.env.BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES;
});

describe('batchTrigger statement count is O(1) in the item count', () => {
  it('an empty batch returns an empty result without a single statement (PF5)', async () => {
    const { pool, stmts } = makePool([TASK('t')]);
    await expect(batchTrigger(pool, [], DEFAULT_NAMESPACE)).resolves.toEqual({ runIds: [] });
    // Not even BEGIN: the guard returns before the transaction opens.
    expect(stmts).toEqual([]);
  });

  it('500 items cost 4 data statements: task preload + runs + queue + one notify', async () => {
    const { pool, stmts } = makePool([TASK('t')]);
    const res = await batchTrigger(
      pool,
      items(500, (i) => ({ taskId: 't', payload: { n: i } })),
      DEFAULT_NAMESPACE,
    );

    expect(res.runIds).toHaveLength(500);
    const data = dataStmts(stmts);
    expect(data).toHaveLength(4);
    // Task preload: one SELECT over the DEDUPLICATED task ids — 500 items of
    // one task is a single VALUES tuple, not 500 lookups.
    expect(findByKind(data, /FROM tasks/)).toHaveLength(1);
    expect(findByKind(data, /FROM tasks/)[0]!.params).toHaveLength(3);
    // Runs: one multi-row INSERT, 13 params per item.
    const runs = findByKind(data, /INSERT INTO runs/);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.params).toHaveLength(500 * 13);
    expect(runs[0]!.sql).toMatch(/ON CONFLICT \(project_id, env, task_id, idempotency_key\)/);
    // Queue: one multi-row INSERT, 6 params per item.
    const queue = findByKind(data, /INSERT INTO queue/);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.params).toHaveLength(500 * 6);
    expect(findByKind(data, /pg_notify/)).toHaveLength(1);
  });

  it('500 distinct tasks still cost the same 4 statements (dedup only shrinks the preload)', async () => {
    const { pool, stmts } = makePool(items(500, (i) => TASK(`task-${i}`)));
    const res = await batchTrigger(
      pool,
      items(500, (i) => ({ taskId: `task-${i}`, payload: null })),
      DEFAULT_NAMESPACE,
    );

    expect(res.runIds).toHaveLength(500);
    const data = dataStmts(stmts);
    expect(data).toHaveLength(4);
    const preload = findByKind(data, /FROM tasks/)[0]!;
    // 500 distinct ids → 500 VALUES tuples → 1500 params. Still ONE statement.
    expect(preload.params).toHaveLength(500 * 3);
  });

  it('the runIds come back in input order (new and conflicted mixed)', async () => {
    const { pool } = makePool([TASK('t')]);
    const input = items(500, (i) => ({
      taskId: 't',
      payload: null,
      options: i % 2 === 0 ? { idempotencyKey: `k-${i}` } : undefined,
    }));
    // First pass creates the even-indexed runs (all new); second pass hits
    // them all again (all conflicts) plus the odd ones (new).
    const first = await batchTrigger(pool, input, DEFAULT_NAMESPACE);
    const second = await batchTrigger(pool, input, DEFAULT_NAMESPACE);

    // Odd (no key): fresh ids, distinct from the first pass. Even: the
    // FIRST pass's id for that key.
    for (let i = 0; i < 500; i++) {
      if (i % 2 === 0) {
        expect(second.runIds[i]).toBe(first.runIds[i]);
      } else {
        expect(second.runIds[i]).not.toBe(first.runIds[i]);
      }
    }
  });
});

describe('batchTrigger idempotency conflict readback', () => {
  it('a fully-conflicted batch costs 3 statements (no queue INSERT, no notify)', async () => {
    const { pool, stmts } = makePool([TASK('t')]);
    const input = items(500, (i) => ({
      taskId: 't',
      payload: null,
      options: { idempotencyKey: `k-${i}` },
    }));
    const first = await batchTrigger(pool, input, DEFAULT_NAMESPACE);
    stmts.length = 0; // start counting at the second call

    const second = await batchTrigger(pool, input, DEFAULT_NAMESPACE);

    expect(second.runIds).toEqual(first.runIds); // same runs, input order
    const data = dataStmts(stmts);
    expect(data).toHaveLength(3); // preload + runs INSERT + conflict readback
    const readback = findByKind(data, /idempotency_key.*IN \(VALUES/);
    expect(readback).toHaveLength(1);
    // 500 conflicted pairs → 4 params each → one batched readback.
    expect(readback[0]!.params).toHaveLength(500 * 4);
    expect(findByKind(data, /INSERT INTO queue/)).toHaveLength(0);
    expect(findByKind(data, /pg_notify/)).toHaveLength(0);
  });

  it('a key repeated inside one batch resolves to one run and one queue row', async () => {
    const { pool, stmts } = makePool([TASK('t')]);
    const res = await batchTrigger(
      pool,
      items(2, () => ({ taskId: 't', payload: null, options: { idempotencyKey: 'same' } })),
      DEFAULT_NAMESPACE,
    );

    expect(res.runIds).toHaveLength(2);
    expect(res.runIds[0]).toBe(res.runIds[1]);
    const queue = findByKind(dataStmts(stmts), /INSERT INTO queue/)[0]!;
    expect(queue.params).toHaveLength(6); // one VALUES tuple — one enqueue
  });
});

describe('batchTrigger byte cap on the total payload', () => {
  const blob = (bytes: number) => 'x'.repeat(bytes);

  it('rejects a batch whose serialized payloads sum past the cap with zero SQL', async () => {
    const { pool, stmts } = makePool([TASK('t')]);
    // 500 × 3 KiB = 1.5 MiB > 1 MiB default — every item fits its own 256 KiB
    // cap, so only the batch-level cap can refuse it.
    await expect(
      batchTrigger(
        pool,
        items(500, (i) => ({ taskId: 't', payload: blob(3 * 1024) })),
        DEFAULT_NAMESPACE,
      ),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/at most 1048576 bytes in total/),
    });
    // The refusal happens before the transaction even opens: no statements at
    // all (not even BEGIN).
    expect(stmts).toEqual([]);
  });

  it('accepts a batch under the cap', async () => {
    const { pool } = makePool([TASK('t')]);
    const res = await batchTrigger(
      pool,
      items(500, (i) => ({ taskId: 't', payload: { n: i } })),
      DEFAULT_NAMESPACE,
    );
    expect(res.runIds).toHaveLength(500);
  });

  it('honours BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES', async () => {
    process.env.BETTER_TRIGGER_MAX_BATCH_PAYLOAD_BYTES = '1024';
    const { pool, stmts } = makePool([TASK('t')]);
    await expect(
      batchTrigger(pool, items(2, () => ({ taskId: 't', payload: blob(600) })), DEFAULT_NAMESPACE),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(stmts).toEqual([]);
  });

  it('a per-item payload over its own cap still surfaces as payload_too_large', async () => {
    const { pool, stmts } = makePool([TASK('t')]);
    await expect(
      batchTrigger(pool, [{ taskId: 't', payload: blob(300 * 1024) }], DEFAULT_NAMESPACE),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(stmts).toEqual([]);
  });
});

describe('batchTrigger all-or-nothing and task resolution', () => {
  it('a missing task rejects the whole batch with task_not_found and inserts nothing', async () => {
    const { pool, stmts } = makePool([TASK('t')]);
    const input = items(500, (i) => ({
      taskId: i === 499 ? 'ghost' : 't',
      payload: null,
    }));
    await expect(batchTrigger(pool, input, DEFAULT_NAMESPACE)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );

    const data = dataStmts(stmts);
    // Only the preload ran; the failure aborted the tx before any INSERT.
    expect(findByKind(data, /FROM tasks/)).toHaveLength(1);
    expect(findByKind(data, /INSERT INTO runs/)).toHaveLength(0);
    expect(findByKind(data, /INSERT INTO queue/)).toHaveLength(0);
    expect(findByKind(data, /pg_notify/)).toHaveLength(0);
  });

  it('resolves per-item options (priority, delay, concurrencyKey) onto the right rows', async () => {
    const { pool, stmts } = makePool([TASK('limited', 5), TASK('open')]);
    await batchTrigger(
      pool,
      [
        { taskId: 'limited', payload: null, options: { concurrencyKey: 'tenant-1' } },
        { taskId: 'limited', payload: null }, // defaults to the task id
        { taskId: 'open', payload: null, options: { concurrencyKey: 'own-key', priority: 7, delay: '1h' } },
      ],
      DEFAULT_NAMESPACE,
    );

    const runs = findByKind(dataStmts(stmts), /INSERT INTO runs/)[0]!;
    // 13 params per row: concurrency_key at +8, priority at +9, task at +3.
    expect(runs.params[8]).toBe('tenant-1');
    expect(runs.params[8 + 13]).toBe('limited'); // limited task defaults to task id
    expect(runs.params[8 + 26]).toBe('own-key'); // open task keeps the caller's key
    expect(runs.params[9 + 26]).toBe(7);

    const queue = findByKind(dataStmts(stmts), /INSERT INTO queue/)[0]!;
    // 6 params per row: available_at at +1, priority at +2, key at +3.
    expect(queue.params[1]).toBeInstanceOf(Date);
    expect(queue.params[1 + 6]).toBeInstanceOf(Date);
    const delayed = queue.params[1 + 12] as Date;
    expect(delayed.getTime()).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(queue.params[2 + 12]).toBe(7);
    expect(queue.params[3 + 12]).toBe('own-key');
  });
});
