/* =============================================================================
   @better-trigger/testing — durable-execution invariant assertions.

   These read the database directly (not the HTTP surface), because the
   invariants they pin are properties of the ledger, not of the API:

     assertSeqContiguous(runId)    seq is a gap-free 0..n-1 prefix — the replay
                                   executor allocates seq monotonically, so a
                                   hole means a step row was lost or a seq was
                                   consumed without being recorded.
     assertNoStepRewrites(runId)   history is append-only: once a step row is
                                   'completed' it never changes again. (A
                                   'failed' row MAY be replaced — that is a
                                   retry re-running the step at the same seq.)
     assertTerminalImmutable(runId) a terminal run stops moving: no queue row,
                                   no pending waits, and the run row + ledger
                                   are byte-identical when re-read later.

   `assertNoStepRewrites` / `assertTerminalImmutable` compare against the
   snapshot taken by their own previous call on the same run, so calling them at
   each interesting moment (e.g. after every injected fault) widens the window
   they cover. The first call establishes the baseline.
   ============================================================================= */
import type { Pool } from 'pg';
import { assert } from './assert';
import { sleep } from './poll';

/** Statuses after which nothing may write to a run. */
export const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'] as const;

export interface StepRow {
  seq: number;
  kind: string;
  label: string | null;
  status: string;
  output: unknown;
  error: unknown;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunRow {
  id: string;
  taskId: string;
  status: string;
  output: unknown;
  error: unknown;
  attempt: number;
  fencingToken: number;
  finishedAt: string | null;
}

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null);

/** Read a run's row. Throws when the run does not exist. */
export async function readRun(pool: Pool, runId: string): Promise<RunRow> {
  const res = await pool.query<{
    id: string;
    task_id: string;
    status: string;
    output: unknown;
    error: unknown;
    attempt: number;
    fencing_token: number;
    finished_at: Date | null;
  }>(
    `SELECT id, task_id, status, output, error, attempt, fencing_token, finished_at
       FROM runs WHERE id = $1`,
    [runId],
  );
  const row = res.rows[0];
  assert(row, `run ${runId} not found`);
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    output: row.output,
    error: row.error,
    attempt: row.attempt,
    fencingToken: Number(row.fencing_token),
    finishedAt: iso(row.finished_at),
  };
}

/** Read a run's step ledger, ordered by seq. */
export async function readSteps(pool: Pool, runId: string): Promise<StepRow[]> {
  const res = await pool.query<{
    seq: number;
    kind: string;
    label: string | null;
    status: string;
    output: unknown;
    error: unknown;
    attempt: number;
    started_at: Date | null;
    finished_at: Date | null;
  }>(
    `SELECT seq, kind, label, status, output, error, attempt, started_at, finished_at
       FROM run_steps WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return res.rows.map((r) => ({
    seq: r.seq,
    kind: r.kind,
    label: r.label,
    status: r.status,
    output: r.output,
    error: r.error,
    attempt: r.attempt,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  }));
}

export interface Invariants {
  /** seq must be 0,1,2,… with no gaps (and match `kinds` when given). */
  assertSeqContiguous(runId: string, opts?: { kinds?: string[] }): Promise<StepRow[]>;
  /** Completed step rows are immutable; rows never disappear. */
  assertNoStepRewrites(runId: string): Promise<StepRow[]>;
  /** A terminal run stops moving (and holds no queue row / pending wait). */
  assertTerminalImmutable(runId: string, opts?: { settleMs?: number }): Promise<RunRow>;
}

/** Bind the invariant assertions to a pool: `const inv = createInvariants(pool)`. */
export function createInvariants(pool: Pool): Invariants {
  /** Last ledger seen per run, keyed by seq — the append-only baseline. */
  const ledgers = new Map<string, Map<number, StepRow>>();
  /** First terminal snapshot seen per run. */
  const terminals = new Map<string, { run: RunRow; steps: string }>();

  const digest = (row: StepRow): string => JSON.stringify(row);

  async function assertSeqContiguous(
    runId: string,
    opts: { kinds?: string[] } = {},
  ): Promise<StepRow[]> {
    const steps = await readSteps(pool, runId);
    steps.forEach((s, i) => {
      assert(
        s.seq === i,
        `run ${runId}: seq must be a gap-free 0..n-1 prefix, got ` +
          `[${steps.map((x) => x.seq).join(', ')}] (position ${i} holds seq ${s.seq})`,
      );
    });
    if (opts.kinds) {
      const kinds = steps.map((s) => s.kind);
      assert(
        JSON.stringify(kinds) === JSON.stringify(opts.kinds),
        `run ${runId}: step ledger should be [${opts.kinds.join(', ')}], got [${kinds.join(', ')}]`,
      );
    }
    return steps;
  }

  async function assertNoStepRewrites(runId: string): Promise<StepRow[]> {
    const steps = await readSteps(pool, runId);

    // Shape checks that need no baseline: a settled row must carry its window.
    for (const s of steps) {
      assert(
        s.status === 'completed' || s.status === 'failed',
        `run ${runId} seq ${s.seq}: unexpected step status '${s.status}'`,
      );
      assert(
        s.startedAt !== null && s.finishedAt !== null,
        `run ${runId} seq ${s.seq}: a settled step row must carry started_at + finished_at`,
      );
      assert(s.attempt >= 1, `run ${runId} seq ${s.seq}: attempt must be >= 1, got ${s.attempt}`);
    }

    const before = ledgers.get(runId);
    const now = new Map(steps.map((s) => [s.seq, s]));
    if (before) {
      for (const [seq, was] of before) {
        const is = now.get(seq);
        assert(is, `run ${runId} seq ${seq}: step row disappeared (history is append-only)`);
        if (was.status === 'completed') {
          assert(
            digest(is) === digest(was),
            `run ${runId} seq ${seq}: a completed step row was rewritten\n` +
              `  was ${digest(was)}\n  is  ${digest(is)}`,
          );
        } else {
          // A failed row may be replaced by a later attempt re-running the step
          // at the same seq — but never by an older attempt (a stale write).
          assert(
            is.attempt >= was.attempt,
            `run ${runId} seq ${seq}: step row moved backwards to attempt ${is.attempt} ` +
              `(was ${was.attempt}) — a stale write landed`,
          );
        }
      }
    }
    ledgers.set(runId, now);
    return steps;
  }

  async function assertTerminalImmutable(
    runId: string,
    opts: { settleMs?: number } = {},
  ): Promise<RunRow> {
    const settleMs = opts.settleMs ?? 500;
    const run = await readRun(pool, runId);
    assert(
      (TERMINAL_STATUSES as readonly string[]).includes(run.status),
      `run ${runId}: expected a terminal status, got '${run.status}'`,
    );
    assert(run.finishedAt !== null, `run ${runId}: a terminal run must have finished_at`);

    const queued = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM queue WHERE run_id = $1`,
      [runId],
    );
    assert(
      queued.rows[0].n === 0,
      `run ${runId}: a terminal run must hold no queue row, got ${queued.rows[0].n}`,
    );
    const pending = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM waits WHERE run_id = $1 AND status = 'pending'`,
      [runId],
    );
    assert(
      pending.rows[0].n === 0,
      `run ${runId}: a terminal run must leave no pending wait, got ${pending.rows[0].n}`,
    );

    const steps = JSON.stringify(await readSteps(pool, runId));
    const snap = { run, steps };

    // Compare against the earliest terminal snapshot we hold (widest window),
    // then against a fresh read after `settleMs` (catches a reaper or a zombie
    // worker still writing right now).
    const earliest = terminals.get(runId) ?? snap;
    if (!terminals.has(runId)) terminals.set(runId, snap);
    await sleep(settleMs);
    const again = { run: await readRun(pool, runId), steps: JSON.stringify(await readSteps(pool, runId)) };
    assert(
      JSON.stringify(again) === JSON.stringify(earliest),
      `run ${runId}: terminal state changed after settling\n` +
        `  was ${JSON.stringify(earliest)}\n  is  ${JSON.stringify(again)}`,
    );
    return again.run;
  }

  return { assertSeqContiguous, assertNoStepRewrites, assertTerminalImmutable };
}
