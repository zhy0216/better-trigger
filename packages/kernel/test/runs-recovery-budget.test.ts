/* =============================================================================
   @better-trigger/kernel — every run is stamped with a recovery budget (C4).

   The reaper decides on runs.recoveries / runs.max_recoveries, so a run created
   without a budget column would be at the mercy of whatever the schema default
   happens to be. createRunIn stamps it explicitly from
   BETTER_TRIGGER_MAX_RECOVERIES (default 10) — an operator setting, not a
   trigger option: how much infrastructure churn a deployment tolerates is not
   something the calling code knows.

   The stub answers the tasks lookup and records the INSERT with its parameters;
   no Postgres.
   ============================================================================= */
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { createRunIn } from '../src/runs';

const makeClient = () => {
  const stmts: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM tasks/.test(sql)) {
        return {
          rows: [{ id: 't', retry: null, concurrency_limit: null, latest_code_version: null }],
        };
      }
      // createRunIn's database-clock read (T1).
      if (/^SELECT now\(\)/.test(sql)) return { rows: [{ now: new Date() }] };
      if (/INSERT INTO runs/.test(sql)) return { rows: [{ id: 'run_1' }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, stmts };
};

/** The value bound to max_recoveries in the INSERT the call issued. */
async function stampedBudget(): Promise<number> {
  const { client, stmts } = makeClient();
  await createRunIn(client, {
      taskId: 't',
      payload: null,
      triggerType: 'api',
      namespace: DEFAULT_NAMESPACE,
    });
  const insert = stmts.find((s) => /INSERT INTO runs/.test(s.sql));
  expect(insert).toBeDefined();
  // Column list and VALUES list are written side by side; find the position of
  // max_recoveries rather than hard-coding $9, so a later column insertion
  // fails loudly here instead of silently stamping the wrong value.
  const cols = insert!.sql
    .slice(insert!.sql.indexOf('(') + 1, insert!.sql.indexOf(')'))
    .split(',')
    .map((c) => c.trim());
  const placeholder = insert!.sql
    .slice(insert!.sql.indexOf('VALUES ('))
    .match(/\(([^)]*)\)/)![1]!
    .split(',')
    .map((v) => v.trim())[cols.indexOf('max_recoveries')]!;
  expect(placeholder).toMatch(/^\$\d+$/);
  return insert!.params[Number(placeholder.slice(1)) - 1] as number;
}

afterEach(() => {
  delete process.env.BETTER_TRIGGER_MAX_RECOVERIES;
});

describe('createRunIn recovery budget', () => {
  it('stamps the default budget', async () => {
    expect(await stampedBudget()).toBe(10);
  });

  it('honors BETTER_TRIGGER_MAX_RECOVERIES, including 0', async () => {
    process.env.BETTER_TRIGGER_MAX_RECOVERIES = '3';
    expect(await stampedBudget()).toBe(3);

    // 0 is a real setting ("fail a lost run at once"), not garbage — the shared
    // envLimit helper would have thrown it away as non-positive.
    process.env.BETTER_TRIGGER_MAX_RECOVERIES = '0';
    expect(await stampedBudget()).toBe(0);
  });

  it('falls back to the default on garbage rather than removing the ceiling', async () => {
    for (const raw of ['many', '-1', '1.5', '']) {
      process.env.BETTER_TRIGGER_MAX_RECOVERIES = raw;
      expect(await stampedBudget()).toBe(10);
    }
  });
});
