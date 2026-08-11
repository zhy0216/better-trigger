/* =============================================================================
   @better-trigger/kernel — the wait-due scanner never queues behind a peer.

   Phase 1 of scanWaits holds no locks, so every daemon reads the same batch of
   due waits (todos/01-correctness.md C1). Phase 2 must therefore treat "another
   instance already has this one" as skip, not as wait: with a blocking
   FOR UPDATE the second daemon stalls on every row in the batch, wakes up, and
   discovers the wait is no longer pending — wakeup throughput falls as daemons
   are added, which is the opposite of what "N daemons, no leader election"
   promises.

   No Postgres: startOrchestrator takes its pool as an argument, so a stub client
   that answers by query shape is enough — and it can do what a live server would
   do to the old code, namely never answer a *blocking* lock on a row a peer
   holds. A regression here does not merely fail an assertion on SQL text, it
   parks the loop exactly as production would.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from '../src/orchestrator';

/** A due timer wait as phase 1 hands it to phase 2. */
interface DueWait {
  id: number;
  runId: string;
  stepSeq: number;
  /** The executor's declared-wait fingerprint (C1), persisted on the waits row. */
  fingerprint?: string | null;
}

interface StubOptions {
  /** Due waits the phase-1 scan returns — once, so a tick is countable. */
  due?: DueWait[];
  /** Run ids whose runs row a peer daemon is holding right now. */
  heldRuns?: string[];
  /** Wait ids whose waits row a peer daemon is holding right now. */
  heldWaits?: number[];
  /** Wait ids a peer already resolved (row free, but no longer 'pending'). */
  resolvedWaits?: number[];
}

/** Only the wait scanner; the other three loops would just add noise. */
const WAITS_ONLY = {
  cron: false,
  reaper: false,
  workerOffline: false,
  timerIntervalMs: 20,
} as const;

/**
 * Answers the queries scanWaits issues, by shape. Row-level locks are modeled
 * the way Postgres implements them: SKIP LOCKED on a held row returns no rows,
 * a plain FOR UPDATE on a held row returns nothing *ever* (and is recorded, so
 * the test can name the offending statement instead of just timing out).
 */
function stubPool(opts: StubOptions = {}) {
  const due = opts.due ?? [];
  const heldRuns = new Set(opts.heldRuns ?? []);
  const heldWaits = new Set(opts.heldWaits ?? []);
  const resolvedWaits = new Set(opts.resolvedWaits ?? []);
  const texts: string[] = [];
  const blockedOn: string[] = [];
  const stepFingerprints: (string | null)[] = [];
  let scanned = false;

  const client = {
    query: async (text: string, params?: unknown[]) => {
      texts.push(text);

      // Canonical position 2 — the runs row.
      if (/FROM runs WHERE id = \$1/.test(text)) {
        const runId = String(params?.[0]);
        const row = due.find((d) => d.runId === runId);
        if (heldRuns.has(runId)) {
          if (!/SKIP LOCKED/.test(text)) {
            blockedOn.push(text);
            return new Promise<never>(() => {}); // a live server would block here
          }
          return { rows: [] };
        }
        return {
          rows: row
            ? [
                {
                  id: runId,
                  task_id: 'demo',
                  status: 'waiting',
                  attempt: 1,
                  max_attempts: 3,
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

      // Canonical position 3 — the wait row, re-checked under its own lock.
      // The namespace predicate sits BEFORE the row-lock clause (the lock
      // clause must be last — a C2 regression once put `AND project_id` after
      // `FOR UPDATE SKIP LOCKED`, which is a 42601 syntax error on every
      // Postgres), so match `pending'` → `FOR UPDATE` across the gap.
      if (/FROM waits WHERE id = \$1 AND status = 'pending'[\s\S]*FOR UPDATE/.test(text)) {
        const id = Number(params?.[0]);
        if (heldWaits.has(id)) {
          if (!/SKIP LOCKED/.test(text)) {
            blockedOn.push(text);
            return new Promise<never>(() => {});
          }
          return { rows: [] };
        }
        return { rows: resolvedWaits.has(id) ? [] : [{ id }] };
      }

      // The resume's step-row write (upsertStep): record the fingerprint slot
      // (param 11 of the INSERT) so tests can pin the waits→run_steps carry.
      if (/INSERT INTO run_steps/.test(text)) {
        // $1 run id, $2/$3 namespace, $4 seq, … fingerprint is param 13.
        const fp = params?.[12];
        stepFingerprints.push(typeof fp === 'string' ? fp : null);
        return { rows: [], rowCount: 0 };
      }

      return { rows: [] };
    },
    release: () => {},
  };

  const pool = {
    connect: async () => client,
    query: async (text: string) => {
      texts.push(text);
      if (/FROM waits/.test(text) && /resume_at <= now\(\)/.test(text)) {
        // Served once: on a 20ms loop the same batch would come back forever
        // and nothing could be counted exactly.
        if (scanned) return { rows: [] };
        scanned = true;
        return {
          rows: due.map((d) => ({
            id: d.id,
            run_id: d.runId,
            project_id: 'default',
            env: 'dev',
            step_seq: d.stepSeq,
            // The executor's declared-wait fingerprint (C1), carried like the
            // real phase-1 query does.
            fingerprint: d.fingerprint ?? null,
          })),
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;

  return { pool, texts, blockedOn, stepFingerprints };
}

const logger = { warn: () => {}, error: () => {} };

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Statements that only a wait actually being resumed produces. */
const resumedWaitIds = (texts: string[]) =>
  texts.filter((t) => /UPDATE waits SET status = 'completed'/.test(t)).length;
const enqueued = (texts: string[]) =>
  texts.filter((t) => /INSERT INTO queue/.test(t)).length;

describe('scanWaits lock acquisition', () => {
  it('takes the runs and wait rows with SKIP LOCKED, the queue row without', async () => {
    const { pool, texts } = stubPool({
      due: [{ id: 1, runId: 'run_a', stepSeq: 1 }],
    });

    const handle = startOrchestrator(pool, logger, WAITS_ONLY);
    try {
      await waitFor(() => resumedWaitIds(texts) > 0);
    } finally {
      handle.stop();
    }

    expect(
      texts.some((t) => /FROM runs WHERE id = \$1.*FOR UPDATE SKIP LOCKED/.test(t)),
    ).toBe(true);
    expect(
      texts.some((t) => /FROM waits WHERE id = \$1 AND status = 'pending'[\s\S]*FOR UPDATE SKIP LOCKED/.test(t)),
    ).toBe(true);
    // Position 1 is deliberately blocking: for a waiting run there is no queue
    // row at all, and holding it when a stale one exists is what stops the
    // closing INSERT ... ON CONFLICT from waiting on queue while runs is held
    // (see the lock-order header in runs.ts).
    expect(
      texts.some((t) => /FROM queue WHERE run_id = \$1.*FOR UPDATE/.test(t)),
    ).toBe(true);
  }, 10_000);

  it('skips a wait whose run row a peer holds, and resumes the rest of the batch', async () => {
    const { pool, texts, blockedOn } = stubPool({
      due: [
        { id: 1, runId: 'run_taken', stepSeq: 1 },
        { id: 2, runId: 'run_free', stepSeq: 1 },
      ],
      heldRuns: ['run_taken'],
    });

    const handle = startOrchestrator(pool, logger, WAITS_ONLY);
    try {
      await waitFor(() => resumedWaitIds(texts) > 0 || blockedOn.length > 0);
    } finally {
      handle.stop();
    }

    // Never parked on the contended row — the batch was walked to the end.
    expect(blockedOn).toEqual([]);
    // Exactly one resume: the free one. The taken one belongs to whoever holds
    // the lock; this instance wrote nothing for it.
    expect(resumedWaitIds(texts)).toBe(1);
    expect(enqueued(texts)).toBe(1);
    expect(texts.some((t) => /FROM waits WHERE id = \$1/.test(t))).toBe(true);
  }, 10_000);

  it('skips a wait whose wait row a peer holds', async () => {
    const { pool, texts, blockedOn } = stubPool({
      due: [
        { id: 1, runId: 'run_a', stepSeq: 1 },
        { id: 2, runId: 'run_b', stepSeq: 1 },
      ],
      heldWaits: [1],
    });

    const handle = startOrchestrator(pool, logger, WAITS_ONLY);
    try {
      await waitFor(() => resumedWaitIds(texts) > 0 || blockedOn.length > 0);
    } finally {
      handle.stop();
    }

    expect(blockedOn).toEqual([]);
    expect(resumedWaitIds(texts)).toBe(1);
  }, 10_000);

  it('resumes a wait exactly once — a peer that got there first leaves nothing to do', async () => {
    // The other half of the promise table: a wait produces one resumption. The
    // instance that loses the race sees the row free but no longer 'pending'
    // (the winner committed) and must write nothing at all — same outcome as
    // being skipped, reached by a different route.
    const { pool, texts, blockedOn } = stubPool({
      due: [{ id: 1, runId: 'run_a', stepSeq: 1 }],
      resolvedWaits: [1],
    });

    const handle = startOrchestrator(pool, logger, WAITS_ONLY);
    try {
      await waitFor(() => texts.filter((t) => t === 'COMMIT').length > 0);
    } finally {
      handle.stop();
    }

    expect(blockedOn).toEqual([]);
    expect(resumedWaitIds(texts)).toBe(0);
    expect(enqueued(texts)).toBe(0);
  }, 10_000);

  it('stamps the completed step row with the waits row fingerprint (C1), not a recomputed one', async () => {
    const { pool, texts, stepFingerprints } = stubPool({
      due: [{ id: 1, runId: 'run_a', stepSeq: 3, fingerprint: 'fp_declared_wait' }],
    });

    const handle = startOrchestrator(pool, logger, WAITS_ONLY);
    try {
      await waitFor(() => stepFingerprints.length > 0);
    } finally {
      handle.stop();
    }

    expect(stepFingerprints).toEqual(['fp_declared_wait']);
    // And the write goes through the immutable upsertStep path — the SQL shape
    // that refuses to overwrite a completed row (C1).
    expect(
      texts.some((t) => /INSERT INTO run_steps/.test(t) && /status <> 'completed'/.test(t)),
    ).toBe(true);
  }, 10_000);
});
