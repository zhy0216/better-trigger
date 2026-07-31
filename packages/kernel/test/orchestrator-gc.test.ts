/* =============================================================================
   @better-trigger/kernel — the retention GC loop is opt-in
   (todos/02-performance.md PF6).

   The fifth orchestrator loop is the only one that deletes user data, so its
   default matters more than its behaviour: a daemon that starts throwing
   finished runs away because nobody passed a flag is a data-loss bug. These
   drive startOrchestrator against a stub pool and check the loop is silent
   without `retentionMs`, does the delete with it, and keeps its own error
   counter when the delete throws (a broken GC must not take the process down,
   and must not look like a working one either).
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from '../src/orchestrator';

/** Every statement the orchestrator issued, off the pool and off a client. */
function stubPool(opts: { failOn?: RegExp } = {}) {
  const texts: string[] = [];
  // Nothing is prunable: the candidate SELECT comes back empty, so the batch
  // loop ends after one pass. What is under test is whether the loop RUNS.
  const query = async (text: string) => {
    texts.push(text);
    if (opts.failOn?.test(text)) throw new Error('connection terminated unexpectedly');
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  const pool = { connect: async () => client, query } as unknown as Pool;
  return { pool, texts };
}

const silentLogger = { warn: () => {}, error: () => {} };

const waitFor = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the loop');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Loops that would otherwise fill the statement log with their own scans. */
const QUIET = { waits: false, cron: false, reaper: false, workerOffline: false } as const;

describe('retention GC loop', () => {
  it('does not exist without retentionMs', async () => {
    const { pool, texts } = stubPool();

    const handle = startOrchestrator(pool, silentLogger, { ...QUIET, gcIntervalMs: 10 });
    try {
      // Long enough for several ticks of a 10ms loop, had one been started.
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      handle.stop();
    }

    expect(texts).toEqual([]);
    expect(handle.counters.gcRunsDeleted).toBe(0);
  });

  it('prunes on every tick once retentionMs is set', async () => {
    const { pool, texts } = stubPool();

    const handle = startOrchestrator(pool, silentLogger, {
      ...QUIET,
      retentionMs: 30 * 86_400_000,
      gcIntervalMs: 10,
    });
    try {
      await waitFor(() => texts.some((t) => /DELETE FROM workers/.test(t)));
    } finally {
      handle.stop();
    }

    expect(texts.some((t) => /SELECT r\.id FROM runs r/.test(t))).toBe(true);
    expect(texts.some((t) => /r\.status = ANY/.test(t))).toBe(true);
  });

  it('counts its own failures instead of dying', async () => {
    const { pool } = stubPool({ failOn: /FROM runs r/ });

    const handle = startOrchestrator(pool, silentLogger, {
      ...QUIET,
      retentionMs: 30 * 86_400_000,
      gcIntervalMs: 10,
    });
    try {
      await waitFor(() => handle.counters.loopErrors.gc > 0);
    } finally {
      handle.stop();
    }

    // Still ticking: a swallowed error must not stop the loop, only be visible.
    const seen = handle.counters.loopErrors.gc;
    expect(seen).toBeGreaterThan(0);
    expect(handle.counters.gcRunsDeleted).toBe(0);
  });

  it('refuses a retention window under the floor, every tick, without deleting', async () => {
    const { pool, texts } = stubPool();

    const handle = startOrchestrator(pool, silentLogger, {
      ...QUIET,
      retentionMs: 1_000,
      gcIntervalMs: 10,
    });
    try {
      await waitFor(() => handle.counters.loopErrors.gc > 0);
    } finally {
      handle.stop();
    }

    // prune() validates before it queries, so a misconfigured window costs a
    // logged error per tick and never a row.
    expect(texts).toEqual([]);
  });
});
