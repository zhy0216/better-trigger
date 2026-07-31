/* =============================================================================
   @better-trigger/kernel — priority survives every re-enqueue (C7).

   runs-retry-config.test.ts pins the retry path. This file covers the other two
   places a run goes back into the queue through an INSERT rather than an UPDATE,
   which are exactly the places a priority can be lost:

     1. a timer wait coming due (orchestrator.scanWaits) — suspendRun deleted the
        queue row, so the resume re-creates it;
     2. a parent woken because its child finished (wakeParentIfWaiting) —
        waitForChildRun deleted the parent's queue row the same way.

   Both used to write priority 0: the first as a literal in the VALUES list, the
   second by omitting it and taking enqueue()'s default. The failure is quiet and
   only shows up under load — a priority-10 run that waits an hour, or that hands
   work to a child, comes back at the tail of the queue. The paths that re-enqueue
   with an UPDATE (failRun's retry branch, the reaper, releaseClaims) keep the
   queue row and are unaffected; the last case here pins that down.

   No Postgres: both entry points take a pool, so a stub that answers by query
   shape and records params is enough.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from '../src/orchestrator';
import { completeRun, failRun } from '../src/runs';

interface Stmt {
  sql: string;
  params: unknown[];
}

/** A runs row as the kernel's RUN_ROW_COLS select returns it. */
const runRow = (over: Record<string, unknown> = {}) => ({
  id: 'run_1',
  task_id: 'demo',
  status: 'running',
  attempt: 1,
  max_attempts: 3,
  recoveries: 0,
  max_recoveries: 10,
  parent_run_id: null,
  payload: null,
  env: 'prod',
  concurrency_key: null,
  priority: 0,
  code_version: null,
  fencing_token: '1',
  ...over,
});

const find = (stmts: Stmt[], re: RegExp): Stmt => {
  const stmt = stmts.find((s) => re.test(s.sql));
  expect(stmt, `no statement matching ${re}`).toBeDefined();
  return stmt!;
};

/**
 * The value bound to `column` in an INSERT written as a column list beside a
 * VALUES list, resolved by position rather than by a hard-coded $n so a later
 * column insertion fails loudly here instead of quietly reading the wrong slot.
 * Returns the literal text when the column is not parameterised — which is the
 * regression this file exists to catch, so it must be visible, not an error.
 */
function bound(stmt: Stmt, column: string): unknown {
  const cols = stmt.sql
    .slice(stmt.sql.indexOf('(') + 1, stmt.sql.indexOf(')'))
    .split(',')
    .map((c) => c.trim());
  const at = cols.indexOf(column);
  expect(at, `${column} is not in the column list`).toBeGreaterThanOrEqual(0);

  const open = stmt.sql.indexOf('VALUES (') + 'VALUES ('.length;
  const values: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of stmt.sql.slice(open)) {
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

  const slot = values[at];
  if (!/^\$\d+$/.test(slot ?? '')) return slot; // a literal — report it as written
  return stmt.params[Number(slot!.slice(1)) - 1];
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/* ------------------------------------------------------- timer wait resume */

describe('scanWaits re-enqueues a resumed run at its own priority', () => {
  /** Only the wait loop; the other three would just add statements. */
  const WAITS_ONLY = {
    cron: false,
    reaper: false,
    workerOffline: false,
    timerIntervalMs: 20,
  } as const;

  function stubPool(priority: number) {
    const stmts: Stmt[] = [];
    let scanned = false;
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        if (/FROM runs WHERE id = \$1 FOR UPDATE/.test(sql)) {
          return { rows: [runRow({ id: 'run_1', status: 'waiting', priority })] };
        }
        if (/FROM waits WHERE id = \$1/.test(sql)) return { rows: [{ id: 1 }] };
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        stmts.push({ sql, params: [] });
        if (/FROM waits/.test(sql) && /resume_at <= now\(\)/.test(sql)) {
          // Served once — on a 20ms loop the same batch would repeat forever.
          if (scanned) return { rows: [] };
          scanned = true;
          return { rows: [{ id: 1, run_id: 'run_1', step_seq: 1 }] };
        }
        return { rows: [] };
      },
    } as unknown as Pool;
    return { pool, stmts };
  }

  it('carries the run row priority into the re-created queue row', async () => {
    const { pool, stmts } = stubPool(10);
    const handle = startOrchestrator(pool, { warn: () => {}, error: () => {} }, WAITS_ONLY);
    try {
      await waitFor(() => stmts.some((s) => /INSERT INTO queue/.test(s.sql)));
    } finally {
      handle.stop();
    }

    // The whole point of the runs.priority column: the queue row that knew this
    // was urgent was deleted by suspendRun an hour ago.
    expect(bound(find(stmts, /INSERT INTO queue/), 'priority')).toBe(10);
  }, 10_000);

  it('still writes 0 for a run that was triggered at 0', async () => {
    const { pool, stmts } = stubPool(0);
    const handle = startOrchestrator(pool, { warn: () => {}, error: () => {} }, WAITS_ONLY);
    try {
      await waitFor(() => stmts.some((s) => /INSERT INTO queue/.test(s.sql)));
    } finally {
      handle.stop();
    }

    // Reads the column rather than hard-coding a default that happens to match.
    expect(bound(find(stmts, /INSERT INTO queue/), 'priority')).toBe(0);
  }, 10_000);
});

/* ------------------------------------------------------------ parent wake */

describe('wakeParentIfWaiting re-enqueues the parent at its own priority', () => {
  /**
   * A child run holding a valid claim, whose parent is waiting on it. The runs
   * lookup answers by id so parent and child can differ.
   */
  function stubPool(parentPriority: number) {
    const stmts: Stmt[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        if (/FROM queue WHERE run_id = \$1/.test(sql)) {
          return { rows: [{ run_id: params[0], locked_by: 'w1' }] };
        }
        if (/FROM runs WHERE id = \$1/.test(sql)) {
          return params[0] === 'run_parent'
            ? {
                rows: [
                  runRow({
                    id: 'run_parent',
                    status: 'waiting',
                    priority: parentPriority,
                    concurrency_key: 'tenant-9',
                  }),
                ],
              }
            : { rows: [runRow({ id: 'run_child', parent_run_id: 'run_parent' })] };
        }
        if (/FROM waits\s+WHERE child_run_id/.test(sql)) {
          return { rows: [{ id: 5, run_id: 'run_parent', step_seq: 2 }] };
        }
        if (/FROM waits WHERE id = \$1/.test(sql)) return { rows: [{ id: 5 }] };
        return { rows: [] };
      },
      release: () => {},
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    return { pool, stmts };
  }

  it('does not drop a high-priority parent to the back of the queue', async () => {
    const { pool, stmts } = stubPool(9);
    await completeRun(pool, {
      runId: 'run_child',
      output: { ok: true },
      workerId: 'w1',
      fencingToken: 1,
    });

    const insert = find(stmts, /INSERT INTO queue/);
    expect(bound(insert, 'priority')).toBe(9);
    // The key is carried on the same call and must not have been displaced by
    // the new parameter.
    expect(bound(insert, 'concurrency_key')).toBe('tenant-9');
    expect(bound(insert, 'run_id')).toBe('run_parent');
  });

  it('carries it on the failure wake too, not just the success one', async () => {
    // terminalFail reaches the same helper; a child that fails must not demote
    // the parent that is about to handle the error.
    const { pool, stmts } = stubPool(9);
    await failRun(pool, {
      runId: 'run_child',
      error: { message: 'boom' },
      abort: true,
      workerId: 'w1',
      fencingToken: 1,
    });

    expect(bound(find(stmts, /INSERT INTO queue/), 'priority')).toBe(9);
  });
});

/* -------------------------------------------------- paths that keep the row */

describe('the UPDATE re-enqueue paths never touch priority', () => {
  it('failRun retry releases the claim without rewriting the queue row', async () => {
    const stmts: Stmt[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        if (/FROM queue WHERE run_id = \$1/.test(sql)) {
          return { rows: [{ run_id: params[0], locked_by: 'w1' }] };
        }
        if (/FROM runs WHERE id = \$1/.test(sql)) {
          // attempt < max_attempts → the retry branch.
          return { rows: [runRow({ id: 'run_1', attempt: 1, max_attempts: 3 })] };
        }
        return { rows: [] };
      },
      release: () => {},
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;

    const res = await failRun(pool, {
      runId: 'run_1',
      error: { message: 'boom' },
      workerId: 'w1',
      fencingToken: 1,
    });
    expect(res.willRetry).toBe(true);

    // No INSERT at all: the queue row survived, so its priority survived with
    // it — which is why only the two INSERT paths above needed fixing.
    expect(stmts.some((s) => /INSERT INTO queue/.test(s.sql))).toBe(false);
    expect(find(stmts, /UPDATE queue/).sql).not.toMatch(/priority/);
  });
});
