/* =============================================================================
   @better-trigger/kernel — claimRuns step-ledger cap (p1-07).

   The per-run `run_steps` snapshot used to be read inside the claim transaction,
   so a fat ledger held the claim window's `FOR UPDATE SKIP LOCKED` rows for as
   long as the materialization took. The claim now commits first; the ledger
   read happens OUTSIDE the transaction. `ClaimRunsArgs.maxSteps` caps the
   snapshot at `maxSteps + 1` rows so overflow is visible without a second count:
   a run that overflows is still claimed but flagged `stepsTruncated` (and its
   steps trimmed), which the executor fails non-retryably.

   What is pinned here:

     - COMMIT lands before the first run_steps read — the ledger is never read
       with the window lock held (the candidate SELECT still takes the queue
       rows `FOR UPDATE OF q SKIP LOCKED`);
     - with maxSteps set, the snapshot carries `LIMIT $4` = maxSteps + 1 and the
       overflowed ClaimedRun is `stepsTruncated: true` with steps trimmed;
     - without maxSteps the snapshot has no LIMIT and never truncates;
     - exactly-at-the-cap is not truncation.

   No Postgres: a stub client replays canned rows per statement shape and
   records everything sent, so the statement sequence itself is asserted.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { claimRuns } from '../src/queue';

interface Stmt {
  sql: string;
  params: unknown[];
}

interface CandidateRow {
  queue_id: number;
  run_id: string;
  task_id: string;
  payload: unknown;
  attempt: number;
  max_attempts: number;
  code_version: string | null;
  project_id: string;
  env: string;
  concurrency_key: string | null;
  concurrency_limit: number | null;
}

interface StepRow {
  seq: number;
  kind: string;
  label: string | null;
  status: string;
  output: unknown;
  error: unknown;
  fingerprint: string | null;
}

const candidate = (over: Partial<CandidateRow> = {}): CandidateRow => ({
  queue_id: 1,
  run_id: 'run_1',
  task_id: 'send-email',
  payload: { to: 'a@b.c' },
  attempt: 1,
  max_attempts: 3,
  code_version: 'v7',
  project_id: 'default',
  env: 'staging',
  concurrency_key: null,
  concurrency_limit: null,
  ...over,
});

const step = (seq: number): StepRow => ({
  seq,
  kind: 'step',
  label: `s${seq}`,
  status: 'completed',
  output: { n: seq },
  error: null,
  fingerprint: `fp-${seq}`,
});

const stepsOfLength = (n: number): StepRow[] =>
  Array.from({ length: n }, (_, i) => step(i + 1));

/** A pool that answers each statement shape with canned rows and logs it. */
function stubPool(rows: CandidateRow[], steps: unknown[] = []) {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM queue q/.test(sql)) return { rows };
      if (/FROM run_steps/.test(sql)) return { rows: steps };
      if (/RETURNING fencing_token/.test(sql)) return { rows: [{ fencing_token: '42' }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, stmts };
}

const ARGS = {
  workerId: 'w1',
  namespaces: [{ projectId: 'default', env: 'staging' }],
  taskIds: ['send-email'],
  leaseMs: 60_000,
  limit: 1,
};

const candidatesStmt = (stmts: Stmt[]) => stmts.find((s) => /FROM queue q/.test(s.sql))!;
const stepsStmt = (stmts: Stmt[]) => stmts.find((s) => /FROM run_steps/.test(s.sql))!;

describe('claimRuns step-ledger cap', () => {
  it('commits the claim transaction before any run_steps read', async () => {
    const { pool, stmts } = stubPool([candidate()], stepsOfLength(1));

    await claimRuns(pool, ARGS);

    // The ledger read must never run with the claim window's FOR UPDATE rows
    // held: COMMIT comes first in the recorded sequence.
    const commitIdx = stmts.findIndex((s) => s.sql === 'COMMIT');
    const stepsIdx = stmts.findIndex((s) => /FROM run_steps/.test(s.sql));
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(stepsIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeLessThan(stepsIdx);

    // The candidate scan still takes the queue rows and only the queue rows.
    expect(candidatesStmt(stmts).sql).toMatch(/FOR UPDATE OF q SKIP LOCKED/);
    expect(candidatesStmt(stmts).sql).not.toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('caps the snapshot at maxSteps + 1 rows and marks overflow truncated', async () => {
    const { pool, stmts } = stubPool([candidate()], stepsOfLength(6));

    const claimed = await claimRuns(pool, { ...ARGS, maxSteps: 5 });

    const steps = stepsStmt(stmts);
    expect(steps.sql).toMatch(/LIMIT \$4/);
    expect(steps.params).toEqual(['run_1', 'default', 'staging', 6]);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.stepsTruncated).toBe(true);
    expect(claimed[0]!.steps).toHaveLength(5);
    expect(claimed[0]!.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads the whole ledger with no LIMIT when maxSteps is unset', async () => {
    const { pool, stmts } = stubPool([candidate()], stepsOfLength(6));

    const claimed = await claimRuns(pool, ARGS);

    const steps = stepsStmt(stmts);
    expect(steps.sql).not.toMatch(/LIMIT/);
    expect(steps.params).toEqual(['run_1', 'default', 'staging']);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.stepsTruncated).toBeUndefined();
    expect(claimed[0]!.steps).toHaveLength(6);
  });

  it('treats a ledger exactly at the cap as not truncated', async () => {
    const { pool, stmts } = stubPool([candidate()], stepsOfLength(5));

    const claimed = await claimRuns(pool, { ...ARGS, maxSteps: 5 });

    expect(stepsStmt(stmts).sql).toMatch(/LIMIT \$4/);
    expect(stepsStmt(stmts).params).toEqual(['run_1', 'default', 'staging', 6]);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.stepsTruncated).toBeUndefined();
    expect(claimed[0]!.steps).toHaveLength(5);
  });
});
