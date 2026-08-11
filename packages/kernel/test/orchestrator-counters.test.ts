/* =============================================================================
   @better-trigger/kernel — the orchestrator counters come from real loop runs.

   OrchestratorCounters is what /api/v1/metrics exports as
   `reaper_recovered_total` and `orchestrator_errors_total` (todos/03 O4). A test
   that hands createOrchestratorCounters() a number and reads it back only proves
   the renderer works — delete the increments in orchestrator.ts and it still
   passes, while both families report 0 forever. So these drive the loops
   themselves.

   No Postgres: startOrchestrator takes its pool as an argument, so a stub that
   answers BEGIN / SELECT / COMMIT (and one that refuses to connect at all) is
   enough to walk every path that touches a counter — including the one that
   must NOT touch one, the transaction that rolls back.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from '../src/orchestrator';

/** An expired claim the reaper will find, plus the runs row behind it. */
interface Stale {
  id: number;
  runId: string;
  attempt: number;
  maxAttempts: number;
  /** Since C4 the reaper decides on these two, not on attempt/maxAttempts. */
  recoveries: number;
  maxRecoveries: number;
}

interface StubOptions {
  /** Expired claims the queue scan hands out — once, so a tick is countable. */
  stale?: Stale[];
  /** Query texts that reject (the tx then rolls back). */
  failOn?: RegExp;
  /** pool.connect() rejects: a database that is simply not there. */
  connectFails?: boolean;
  /** pool.query() rejects — the waits scan runs off the pool directly. */
  poolQueryFails?: boolean;
}

/**
 * The queries the reaper actually issues, answered by shape. Anything not
 * matched here (the UPDATEs, the DELETE, BEGIN/COMMIT) is a write whose result
 * the reaper ignores, so an empty rowset is the honest answer.
 */
function stubPool(opts: StubOptions = {}) {
  const stale = opts.stale ?? [];
  const texts: string[] = [];
  let scanned = false;
  let released = 0;

  const client = {
    query: async (text: string, params?: unknown[]) => {
      texts.push(text);
      if (opts.failOn?.test(text)) throw new Error('connection terminated unexpectedly');
      if (/FROM queue q/.test(text)) {
        // Served once: a loop on a 20ms interval would otherwise keep finding
        // the same expired claims and the counts could not be pinned exactly.
        if (scanned) return { rows: [] };
        scanned = true;
        return {
          rows: stale.map((s) => ({
            id: s.id,
            run_id: s.runId,
            project_id: 'default',
            env: 'dev',
          })),
        };
      }
      if (/FROM runs WHERE id = \$1/.test(text)) {
        const row = stale.find((s) => s.runId === params?.[0]);
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
                  project_id: 'default',
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
    release: () => {
      released += 1;
    },
  };

  const pool = {
    connect: async () => {
      if (opts.connectFails) throw new Error('ECONNREFUSED');
      return client;
    },
    query: async () => {
      if (opts.poolQueryFails) throw new Error('ECONNREFUSED');
      return { rows: [] };
    },
  } as unknown as Pool;

  return { pool, texts, released: () => released };
}

function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      warn: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
    },
  };
}

/** Only the reaper: the other three loops would just add noise to the stub. */
const REAPER_ONLY = {
  waits: false,
  cron: false,
  workerOffline: false,
  reaperIntervalMs: 20,
} as const;

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('reaper recovery counters', () => {
  it('counts a requeued claim and a terminal one, from an actual reap', async () => {
    const { pool, texts } = stubPool({
      stale: [
        // Recovery budget left → handed back to the queue.
        {
          id: 1,
          runId: 'run_requeued',
          attempt: 1,
          maxAttempts: 3,
          recoveries: 0,
          maxRecoveries: 10,
        },
        // Out of recoveries → terminal 'worker lost' (attempt is untouched and
        // deliberately nowhere near its own limit — see C4).
        {
          id: 2,
          runId: 'run_lost',
          attempt: 1,
          maxAttempts: 3,
          recoveries: 10,
          maxRecoveries: 10,
        },
      ],
    });
    const { logger, lines } = recordingLogger();

    const handle = startOrchestrator(pool, logger, REAPER_ONLY);
    try {
      await waitFor(() => texts.includes('COMMIT'));
      await waitFor(() => handle.counters.reaperRequeued > 0);
    } finally {
      handle.stop();
    }

    expect(handle.counters.reaperRequeued).toBe(1);
    expect(handle.counters.reaperFailed).toBe(1);
    // The reap ran cleanly — nothing here is a swallowed loop error.
    expect(handle.counters.loopErrors.reaper).toBe(0);
    expect(lines).toEqual([]);
  }, 10_000);

  it('leaves both counters at zero when there is nothing expired', async () => {
    const { pool, texts } = stubPool({ stale: [] });
    const { logger } = recordingLogger();

    const handle = startOrchestrator(pool, logger, REAPER_ONLY);
    try {
      await waitFor(() => texts.includes('COMMIT'));
    } finally {
      handle.stop();
    }

    expect(handle.counters.reaperRequeued).toBe(0);
    expect(handle.counters.reaperFailed).toBe(0);
  }, 10_000);

  it('does not count a transaction that rolled back', async () => {
    // The reason the increments sit after COMMIT rather than inside the loop:
    // a tx that rolls back recovered nothing, and counting the attempt would
    // report recoveries that never happened. Until now that was guaranteed
    // only by where the two lines are written.
    const { pool, texts, released } = stubPool({
      stale: [
        {
          id: 1,
          runId: 'run_requeued',
          attempt: 1,
          maxAttempts: 3,
          recoveries: 0,
          maxRecoveries: 10,
        },
        {
          id: 2,
          runId: 'run_lost',
          attempt: 1,
          maxAttempts: 3,
          recoveries: 10,
          maxRecoveries: 10,
        },
      ],
      failOn: /^COMMIT$/,
    });
    const { logger, lines } = recordingLogger();

    const handle = startOrchestrator(pool, logger, REAPER_ONLY);
    try {
      await waitFor(() => handle.counters.loopErrors.reaper > 0);
    } finally {
      handle.stop();
    }

    // Both rows were walked (the local tally reached 1 and 1) and neither
    // landed on the shared counters.
    expect(texts).toContain('ROLLBACK');
    expect(handle.counters.reaperRequeued).toBe(0);
    expect(handle.counters.reaperFailed).toBe(0);
    // The failure itself is not silent, and the client went back to the pool.
    expect(lines.some((l) => l.includes('[orchestrator:reaper]'))).toBe(true);
    expect(released()).toBeGreaterThan(0);
  }, 10_000);
});

describe('loop error counters', () => {
  it('counts a throwing iteration per loop, and the loop keeps ticking', async () => {
    // A database that is not there: the waits scan fails on pool.query, the
    // cron and reaper loops fail on pool.connect.
    const { pool } = stubPool({ connectFails: true, poolQueryFails: true });
    const { logger, lines } = recordingLogger();

    const handle = startOrchestrator(pool, logger, {
      timerIntervalMs: 20,
      cronIntervalMs: 20,
      reaperIntervalMs: 20,
      // The offline marker is on a fixed 30s interval — out of reach of a test
      // this size, and it goes through the same wrapper as the other three.
      workerOffline: false,
    });
    try {
      await waitFor(
        () =>
          handle.counters.loopErrors.waits > 0 &&
          handle.counters.loopErrors.cron > 0 &&
          handle.counters.loopErrors.reaper > 0,
      );
      // Swallowed, not fatal: the loop is still running afterwards.
      const seen = handle.counters.loopErrors.waits;
      await waitFor(() => handle.counters.loopErrors.waits > seen);
    } finally {
      handle.stop();
    }

    expect(handle.counters.loopErrors.workers).toBe(0);
    expect(lines.some((l) => l.includes('[orchestrator:waits]'))).toBe(true);
    expect(lines.some((l) => l.includes('[orchestrator:cron]'))).toBe(true);
    expect(lines.some((l) => l.includes('[orchestrator:reaper]'))).toBe(true);
  }, 10_000);

  it('stays at zero while the loops run without throwing', async () => {
    const { pool, texts } = stubPool();
    const { logger } = recordingLogger();

    const handle = startOrchestrator(pool, logger, {
      timerIntervalMs: 20,
      cronIntervalMs: 20,
      reaperIntervalMs: 20,
      workerOffline: false,
    });
    try {
      await waitFor(() => texts.filter((t) => t === 'COMMIT').length >= 2);
    } finally {
      handle.stop();
    }

    // `gc` and `stranded` are in here even though neither loop was started: the
    // counter set is fixed so a series never appears or vanishes between
    // metrics scrapes.
    expect(handle.counters.loopErrors).toEqual({
      waits: 0,
      cron: 0,
      reaper: 0,
      workers: 0,
      gc: 0,
      stranded: 0,
    });
  }, 10_000);
});
