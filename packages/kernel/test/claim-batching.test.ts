/* =============================================================================
   @better-trigger/kernel — claimRuns candidate fan-out (PF4).

   The claim loop used to send two extra statements per *candidate*: one
   `SELECT ... FROM runs WHERE id = $1` and one `SELECT concurrency_limit FROM
   tasks`. With the window at 10 that is 20+ round trips for a call that
   normally claims a single run — all inside the transaction that holds the
   whole window FOR UPDATE. The candidate SELECT already joined `runs` for the
   task filter, so both reads fold into it.

   What is pinned here:

     - the merged candidate SELECT joins runs + tasks and carries the run's
       execution columns and the task's concurrency_limit;
     - it still locks the queue row and nothing else (`FOR UPDATE OF q`) — the
       canonical lock order (queue → runs, see runs.ts header) says the runs row
       may not be locked before the queue row, and a bare `FOR UPDATE` on this
       join would lock runs rows too;
     - no per-candidate runs/tasks read survives: a window of N candidates costs
       a constant number of statements, plus one run_steps read per *claimed*
       run (that one cannot be merged — it is only needed for the winners);
     - the ClaimedRun handed back is field-for-field what the split version
       produced, fencing token still read from the RETURNING of the same-tx
       UPDATE that bumps it.

   No Postgres: a stub client replays canned rows per statement shape and
   records everything sent.
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

const candidate = (over: Partial<CandidateRow> = {}): CandidateRow => ({
  queue_id: 1,
  run_id: 'run_1',
  task_id: 'send-email',
  payload: { to: 'a@b.c' },
  attempt: 2,
  max_attempts: 3,
  code_version: 'v7',
  project_id: 'default',
  env: 'staging',
  concurrency_key: null,
  concurrency_limit: null,
  ...over,
});

/** A pool that answers each statement shape with canned rows and logs it. */
function stubPool(rows: CandidateRow[], opts: { steps?: unknown[]; running?: number } = {}) {
  const stmts: Stmt[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM queue q/.test(sql)) return { rows };
      if (/FROM run_steps/.test(sql)) return { rows: opts.steps ?? [] };
      if (/RETURNING fencing_token/.test(sql)) return { rows: [{ fencing_token: '42' }] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: String(opts.running ?? 0) }] };
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
};
/** The two statements PF4 deleted, matched on their exact old shapes. */
const perCandidateReads = (stmts: Stmt[]) =>
  stmts.filter((s) => /FROM (runs|tasks) WHERE id = \$1/.test(s.sql));

describe('claimRuns candidate fan-out', () => {
  it('reads runs and tasks with the candidates, not once per candidate', async () => {
    // Ten candidates, every one of them capped by its task's concurrency limit →
    // the loop walks the whole window and claims nothing. The old shape spent 20
    // reads getting there; the merged one spends none.
    const rows = Array.from({ length: 10 }, (_, i) =>
      candidate({ queue_id: i + 1, run_id: `run_${i}`, concurrency_limit: 1 }),
    );
    const { pool, stmts } = stubPool(rows, { running: 1 });

    expect(await claimRuns(pool, { ...ARGS, limit: 1 })).toEqual([]);

    expect(perCandidateReads(stmts)).toHaveLength(0);
    // BEGIN + candidates + (advisory lock + count) × 10 + COMMIT.
    expect(stmts).toHaveLength(23);

    const cand = stmts.find((s) => /FROM queue q/.test(s.sql))!;
    expect(cand.sql).toMatch(/JOIN runs r ON r\.id = q\.run_id/);
    expect(cand.sql).toMatch(/LEFT JOIN tasks t ON t\.id = r\.task_id/);
    expect(cand.sql).toMatch(/t\.concurrency_limit/);
  });

  it('locks the queue row only — the join must not pull runs into position 1', async () => {
    const { pool, stmts } = stubPool([]);

    await claimRuns(pool, { ...ARGS, limit: 1 });

    const cand = stmts.find((s) => /FROM queue q/.test(s.sql))!;
    expect(cand.sql).toMatch(/FOR UPDATE OF q SKIP LOCKED/);
    // A bare `FOR UPDATE` would lock r (and t) as well, breaking the 1→2 order.
    expect(cand.sql).not.toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('costs a constant statement count per claim, plus one run_steps read', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      candidate({ queue_id: i + 1, run_id: `run_${i}` }),
    );
    const { pool, stmts } = stubPool(rows);

    await claimRuns(pool, { ...ARGS, limit: 1 });

    // BEGIN, candidates, UPDATE queue, UPDATE runs, run_steps, COMMIT.
    expect(stmts.map((s) => s.sql.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'BEGIN',
      'SELECT q.id',
      'UPDATE queue',
      'UPDATE runs',
      'SELECT seq,',
      'COMMIT',
    ]);
    expect(perCandidateReads(stmts)).toHaveLength(0);
  });

  it('hands back the same ClaimedRun the split reads produced', async () => {
    const { pool, stmts } = stubPool(
      [
        candidate({
          queue_id: 77,
          run_id: 'run_abc',
          payload: { to: 'a@b.c' },
          attempt: 2,
          max_attempts: 3,
          code_version: 'v7',
          env: 'staging',
        }),
      ],
      {
        steps: [
          {
            seq: 1,
            kind: 'run',
            label: 'fetch',
            status: 'completed',
            output: { ok: true },
            error: null,
          },
        ],
      },
    );

    const claimed = await claimRuns(pool, { ...ARGS, limit: 1 });

    expect(claimed).toHaveLength(1);
    const run = claimed[0]!;
    expect(run.id).toBe('run_abc');
    expect(run.taskId).toBe('send-email');
    expect(run.payload).toEqual({ to: 'a@b.c' });
    expect(run.attempt).toBe(2);
    expect(run.maxAttempts).toBe(3);
    expect(run.codeVersion).toBe('v7');
    expect(run.env).toBe('staging');
    expect(run.fencingToken).toBe(42);
    expect(run.steps).toEqual([
      {
        seq: 1,
        kind: 'run',
        label: 'fetch',
        status: 'completed',
        output: { ok: true },
        error: undefined,
        fingerprint: null,
      },
    ]);

    // The lease goes on the queue row's own id (q.id), not the run id — the
    // merged SELECT aliases it, and mixing the two would lease a stranger's row.
    const lease = stmts.find((s) => /UPDATE queue/.test(s.sql))!;
    expect(lease.params[2]).toBe(77);
    // Fencing token comes from the runs UPDATE, keyed by run id.
    const bump = stmts.find((s) => /RETURNING fencing_token/.test(s.sql))!;
    expect(bump.params).toEqual(['run_abc', 'default', 'staging']);
  });

  it('still applies the concurrency limit carried on the candidate row', async () => {
    const rows = [
      candidate({ queue_id: 1, run_id: 'run_a', concurrency_key: 'tenant-1' }),
      candidate({
        queue_id: 2,
        run_id: 'run_b',
        concurrency_key: 'tenant-2',
        concurrency_limit: 1,
      }),
    ];
    const { pool, stmts } = stubPool(rows);

    await claimRuns(pool, { ...ARGS, limit: 2 });

    // Only the candidate whose task has a limit takes the advisory lock + count,
    // and the key is the run's concurrency_key (falling back to task id).
    const locks = stmts.filter((s) => /pg_advisory_xact_lock/.test(s.sql));
    expect(locks).toHaveLength(1);
    expect(locks[0]!.params[1]).toBe('bt:cc:default:staging:tenant-2');
  });
});
