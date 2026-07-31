/* =============================================================================
   @better-trigger/kernel — the reaper spends recoveries, never attempts (C4).

   `maxAttempts: 3` is a promise about the USER's code ("it may throw three
   times"), but a worker disappearing is infrastructure: a deploy, an OOM kill,
   a laptop that slept. Charging both to the same counter meant three restarts
   could declare a perfectly healthy long run 'worker lost'. Since C4 the
   expired-lease path increments `runs.recoveries` and is bounded by
   `runs.max_recoveries` — a separate, much wider budget — while `runs.attempt`
   is left exactly where the last execution put it.

   These are the SQL-level guarantees behind that sentence, pinned against a
   stub client (no Postgres): which counter the recovery UPDATE moves, which
   pair the terminal decision reads, and that the resulting error says WHICH
   budget ran out — 'worker lost' on its own reads like the user's code failed.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from '../src/orchestrator';

/** The runs row behind one expired claim. */
interface Stale {
  runId: string;
  attempt: number;
  maxAttempts: number;
  recoveries: number;
  maxRecoveries: number;
}

interface Stmt {
  sql: string;
  params: unknown[];
}

/**
 * Answers the four reads the reaper makes and records every statement with its
 * parameters — the error payload only exists as a bind parameter, so texts
 * alone would not be enough here.
 */
function stubPool(stale: Stale[]) {
  const stmts: Stmt[] = [];
  let scanned = false;

  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM queue q/.test(sql)) {
        // Served once: the loop keeps ticking, and a second helping would
        // double every assertion below.
        if (scanned) return { rows: [] };
        scanned = true;
        return { rows: stale.map((s, i) => ({ id: i + 1, run_id: s.runId })) };
      }
      if (/FROM runs WHERE id = \$1 FOR UPDATE/.test(sql)) {
        const row = stale.find((s) => s.runId === params[0]);
        return {
          rows: row
            ? [
                {
                  id: row.runId,
                  task_id: 'demo',
                  status: 'running',
                  attempt: row.attempt,
                  max_attempts: row.maxAttempts,
                  recoveries: row.recoveries,
                  max_recoveries: row.maxRecoveries,
                  parent_run_id: null,
                  payload: null,
                  env: 'dev',
                  concurrency_key: null,
                  code_version: null,
                  fencing_token: '1',
                },
              ]
            : [],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  };

  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [] }),
  } as unknown as Pool;

  return { pool, stmts };
}

const REAPER_ONLY = {
  waits: false,
  cron: false,
  workerOffline: false,
  reaperIntervalMs: 20,
} as const;

const silentLogger = { warn: () => {}, error: () => {} };

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Run one reap tick against `stale` and hand back what it issued. */
async function reapOnce(stale: Stale[]): Promise<{ stmts: Stmt[]; failed: number; requeued: number }> {
  const { pool, stmts } = stubPool(stale);
  const handle = startOrchestrator(pool, silentLogger, REAPER_ONLY);
  try {
    await waitFor(() => stmts.some((s) => s.sql === 'COMMIT'));
  } finally {
    handle.stop();
  }
  return {
    stmts,
    failed: handle.counters.reaperFailed,
    requeued: handle.counters.reaperRequeued,
  };
}

const runsUpdates = (stmts: Stmt[]) => stmts.filter((s) => /UPDATE runs/.test(s.sql));

describe('lease recovery', () => {
  it('spends a recovery and leaves the attempt alone', async () => {
    const { stmts, requeued, failed } = await reapOnce([
      { runId: 'run_a', attempt: 2, maxAttempts: 3, recoveries: 0, maxRecoveries: 10 },
    ]);

    const update = runsUpdates(stmts)[0];
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/status = 'queued'/);
    expect(update!.sql).toMatch(/recoveries = recoveries \+ 1/);
    // The whole point of C4: the user's retry budget is not the reaper's to
    // spend, so no *write* on this path may mention it (the row read does —
    // the error message quotes the attempt it did not consume).
    const writes = stmts.filter((s) => /^\s*(UPDATE|INSERT|DELETE)/i.test(s.sql));
    expect(writes.map((s) => s.sql).join('\n')).not.toMatch(/attempt/i);

    // The claim itself is handed back, so the next poll can pick the run up.
    const queueUpdate = stmts.find((s) => /UPDATE queue/.test(s.sql));
    expect(queueUpdate!.sql).toMatch(/locked_by = NULL/);
    expect(queueUpdate!.sql).toMatch(/available_at = now\(\)/);

    expect(requeued).toBe(1);
    expect(failed).toBe(0);
  }, 10_000);

  it('recovers a run that is already at max_attempts', async () => {
    // The pre-C4 rule (`attempt >= max_attempts` → terminal) would kill this
    // run: a task with maxAttempts 1 whose worker was SIGKILLed once. Its code
    // never failed, so it gets its ledger replayed instead.
    const { stmts, requeued, failed } = await reapOnce([
      { runId: 'run_b', attempt: 1, maxAttempts: 1, recoveries: 0, maxRecoveries: 10 },
    ]);

    expect(runsUpdates(stmts)[0]!.sql).toMatch(/recoveries = recoveries \+ 1/);
    expect(requeued).toBe(1);
    expect(failed).toBe(0);
  }, 10_000);

  it('terminal-fails once the recovery budget is gone, with a distinguishable error', async () => {
    const { stmts, requeued, failed } = await reapOnce([
      { runId: 'run_c', attempt: 1, maxAttempts: 3, recoveries: 10, maxRecoveries: 10 },
    ]);

    const update = runsUpdates(stmts)[0];
    expect(update!.sql).toMatch(/status = 'failed'/);
    const error = JSON.parse(String(update!.params[1])) as { message: string; name?: string };
    // Still 'worker lost' (that is what happened), but it has to say which
    // budget ran out — this run never spent an attempt.
    expect(error.message).toContain('worker lost');
    expect(error.message).toContain('recovery budget exhausted');
    expect(error.message).toContain('10/10');
    expect(error.message).toContain('attempt 1/3');
    expect(error.name).toBe('WorkerLostError');

    // Full terminal wrap-up, so a waiting parent is not left hanging.
    expect(stmts.some((s) => /DELETE FROM queue/.test(s.sql))).toBe(true);
    expect(stmts.some((s) => /UPDATE waits SET status = 'canceled'/.test(s.sql))).toBe(true);

    expect(failed).toBe(1);
    expect(requeued).toBe(0);
  }, 10_000);

  it('decides per run, not per batch', async () => {
    const { requeued, failed } = await reapOnce([
      { runId: 'run_d', attempt: 3, maxAttempts: 3, recoveries: 1, maxRecoveries: 10 },
      { runId: 'run_e', attempt: 1, maxAttempts: 3, recoveries: 10, maxRecoveries: 10 },
      // max_recoveries 0 — the operator setting that says "never recover a lost
      // run" (BETTER_TRIGGER_MAX_RECOVERIES=0).
      { runId: 'run_f', attempt: 1, maxAttempts: 3, recoveries: 0, maxRecoveries: 0 },
    ]);

    expect(requeued).toBe(1);
    expect(failed).toBe(2);
  }, 10_000);
});
