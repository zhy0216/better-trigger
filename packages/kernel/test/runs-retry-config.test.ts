/* =============================================================================
   @better-trigger/kernel — a manual retry keeps the source run's scheduling
   config (C7).

   retryRun creates a NEW run through createRunIn, so whatever it fails to pass
   in `options` silently falls back to the task defaults: priority 0 (back of
   the queue) and concurrency_key = task_id (sharing the task's default quota
   bucket instead of the caller's). Both are carried over now — priority off the
   runs row, since the source run is terminal and its queue row is long deleted.
   The idempotency key is deliberately NOT carried over (it would make the retry
   collide with the run it retries), which the last case pins down.

   The stub answers the source-run read and the tasks lookup and records every
   statement with its parameters; no Postgres.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { retryRun } from '../src/runs';

interface Stmt {
  sql: string;
  params: unknown[];
}

interface SourceRun {
  status?: string;
  concurrency_key?: string | null;
  priority?: number;
  /** Whether the task the run belongs to declares a concurrency limit. */
  taskConcurrencyLimit?: number | null;
}

/**
 * A pool whose one connection answers the two SELECTs retryRun's transaction
 * reaches (the source run, then the task behind the new run) and records the
 * INSERTs it issues.
 */
const makePool = (src: SourceRun = {}) => {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM runs WHERE id/.test(sql)) {
        return {
          rows: [
            {
              id: 'run_src',
              task_id: 't',
              status: src.status ?? 'failed',
              attempt: 3,
              max_attempts: 3,
              recoveries: 0,
              max_recoveries: 10,
              parent_run_id: null,
              payload: { a: 1 },
              project_id: 'default',
              env: 'staging',
              concurrency_key: src.concurrency_key ?? null,
              priority: src.priority ?? 0,
              code_version: null,
              fencing_token: '4',
            },
          ],
        };
      }
      if (/FROM tasks/.test(sql)) {
        return {
          rows: [
            {
              id: 't',
              retry: null,
              concurrency_limit: src.taskConcurrencyLimit ?? null,
              latest_code_version: null,
            },
          ],
        };
      }
      if (/INSERT INTO runs/.test(sql)) return { rows: [{ id: 'run_new' }] };
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, stmts };
};

/**
 * The value bound to `column` in an INSERT written as a column list beside a
 * VALUES list. Resolved by position rather than by a hard-coded $n so that a
 * later column insertion fails loudly here instead of quietly binding the wrong
 * value. Splits the VALUES list at top-level commas only — it contains `now()`.
 */
function bound(stmt: Stmt, column: string): unknown {
  const cols = stmt.sql
    .slice(stmt.sql.indexOf('(') + 1, stmt.sql.indexOf(')'))
    .split(',')
    .map((c) => c.trim());
  const at = cols.indexOf(column);
  expect(at, `${column} is not in the column list`).toBeGreaterThanOrEqual(0);

  const values: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of stmt.sql.slice(stmt.sql.indexOf('VALUES (') + 'VALUES ('.length)) {
    if (ch === '(') depth++;
    else if (ch === ')' && depth === 0) break;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  values.push(current.trim());

  const placeholder = values[at];
  expect(placeholder, `${column} is not bound to a parameter`).toMatch(/^\$\d+$/);
  return stmt.params[Number(placeholder!.slice(1)) - 1];
}

const find = (stmts: Stmt[], re: RegExp): Stmt => {
  const stmt = stmts.find((s) => re.test(s.sql));
  expect(stmt, `no statement matching ${re}`).toBeDefined();
  return stmt!;
};

describe('retryRun carries the source run config', () => {
  it('reuses the source concurrency key instead of the task default', async () => {
    // A run triggered with its own key, on a task that HAS a limit — the case
    // where losing the key means the retry competes in a different bucket.
    const { pool, stmts } = makePool({
      concurrency_key: 'tenant-42',
      taskConcurrencyLimit: 2,
    });
    await retryRun(pool, 'run_src', DEFAULT_NAMESPACE);

    expect(bound(find(stmts, /INSERT INTO runs/), 'concurrency_key')).toBe('tenant-42');
    expect(find(stmts, /INSERT INTO queue/).params).toContain('tenant-42');
  });

  it('reuses the source priority on both the run row and its queue row', async () => {
    const { pool, stmts } = makePool({ priority: 7 });
    await retryRun(pool, 'run_src', DEFAULT_NAMESPACE);

    // The redundant runs column is what made this possible: the source run is
    // terminal, so its queue row (the scheduler's copy) no longer exists.
    expect(bound(find(stmts, /INSERT INTO runs/), 'priority')).toBe(7);
    // And the new run is actually scheduled at it — the queue row is what the
    // claim scan orders by.
    expect(bound(find(stmts, /INSERT INTO queue/), 'priority')).toBe(7);
  });

  it('leaves a run with no key/priority on the task defaults', async () => {
    const { pool, stmts } = makePool({ concurrency_key: null, priority: 0 });
    await retryRun(pool, 'run_src', DEFAULT_NAMESPACE);

    // NULL concurrency_key means "the task has no limit"; createRunIn re-derives
    // that from the task rather than being handed an empty string.
    expect(bound(find(stmts, /INSERT INTO runs/), 'concurrency_key')).toBeNull();
    expect(bound(find(stmts, /INSERT INTO runs/), 'priority')).toBe(0);
  });

  it('does not carry the idempotency key over', async () => {
    const { pool, stmts } = makePool({ priority: 7 });
    await retryRun(pool, 'run_src', DEFAULT_NAMESPACE);

    // A retry that reuses the key would hit the partial unique index and be
    // answered with the id of the run it was meant to retry.
    const insert = find(stmts, /INSERT INTO runs/);
    expect(bound(insert, 'idempotency_key')).toBeNull();
    expect(insert.sql).not.toMatch(/ON CONFLICT/);
  });

  it('refuses a non-terminal run before creating anything', async () => {
    const { pool, stmts } = makePool({ status: 'running' });
    await expect(retryRun(pool, 'run_src', DEFAULT_NAMESPACE)).rejects.toThrow(/not retryable/);
    expect(stmts.some((s) => /INSERT/.test(s.sql))).toBe(false);
  });
});
