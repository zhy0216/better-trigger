/* =============================================================================
   @better-trigger/kernel — data retention (todos/02-performance.md PF6).

   Nothing in this engine ever deleted history: `runs` / `run_steps` / `logs`
   grow forever, and `workers` gains a row on every process start (a `bun
   --watch` session adds one per reload). `prune()` is the one place that
   takes history back out, by a single rule — age since the row stopped being
   interesting:

     - a run that reached a terminal state before the cutoff, plus everything
       that hangs off it. Since migration 0007 `logs.run_id` and
       `run_steps.run_id` are real foreign keys ON DELETE CASCADE, so deleting
       the run row IS deleting its logs and its step timeline. `waits` and
       `queue` carry no such constraint and are deleted explicitly here;
     - a worker row already marked offline whose last heartbeat is older than
       the cutoff.

   Non-terminal runs are never touched at any age — a run that has been queued
   for 40 days is a bug to look at, not garbage — and neither is a task, a
   schedule or anything else the user declared rather than the engine produced.

   Deleting runs in bounded batches, one transaction each, is deliberate: the
   first prune of a database that has been running for months is a big delete,
   and doing it in one transaction would hold locks across all of it and make
   the cascade a single enormous statement. Batches let the daemon's other
   loops interleave, and an interrupted prune has simply pruned less.

   `dryRun` reports exactly what a real run would remove and issues no DELETE
   at all — the counting path is a separate, read-only set of queries, so the
   flag cannot be defeated by a code path that deletes first and counts after.
   ============================================================================= */
import type { Pool } from 'pg';
import { KernelError } from '@better-trigger/core';
import { withTx } from './runs';

/** Run states that are over. Anything else is live work, whatever its age. */
const TERMINAL_STATUSES: string[] = ['completed', 'failed', 'canceled'];

/** Runs deleted per transaction. See the header for why this is batched. */
export const PRUNE_BATCH = 500;

/**
 * Safety floor on the retention window. `prune --older-than 0` (or a GC loop
 * configured with `retention: 0`) would delete a run the instant it finished,
 * including the one whose result a client is still polling for — that is never
 * what someone means, so it is refused rather than obeyed.
 */
export const MIN_RETENTION_MS = 60_000;

export interface PruneArgs {
  /** Delete terminal runs / offline workers older than this many ms. */
  olderThanMs: number;
  /** Report what would be deleted, delete nothing. Default false. */
  dryRun?: boolean;
  /** Runs deleted per transaction (default PRUNE_BATCH). */
  batchSize?: number;
}

export interface PruneResult {
  /** The instant everything older than which was considered. */
  cutoff: Date;
  /** True when nothing was actually deleted. */
  dryRun: boolean;
  /** Terminal runs removed (or, dry, removable). */
  runs: number;
  /** run_steps rows that went with them (via the FK cascade). */
  runSteps: number;
  /** logs rows that went with them (via the FK cascade). */
  logs: number;
  /** waits rows that went with them (deleted explicitly — no FK). */
  waits: number;
  /** queue rows that went with them (deleted explicitly — no FK). */
  queue: number;
  /** Offline worker rows removed. */
  workers: number;
}

const emptyResult = (cutoff: Date, dryRun: boolean): PruneResult => ({
  cutoff,
  dryRun,
  runs: 0,
  runSteps: 0,
  logs: 0,
  waits: 0,
  queue: 0,
  workers: 0,
});

/** count(*) comes back as bigint, i.e. a string over the wire. */
const num = (v: string | number | undefined | null): number => Number(v ?? 0);

/**
 * The age of a terminal run. `finished_at` is what every terminal path writes,
 * but it is nullable in the schema, so a row that reached a terminal status
 * without one (an older database, a hand-written UPDATE) would otherwise be
 * unprunable forever. `updated_at` is NOT NULL and is written by the same
 * statements, which makes it the correct fallback rather than a guess.
 */
const RUN_AGE = `COALESCE(r.finished_at, r.updated_at)`;

/** WHERE clause selecting prunable runs. $1 = cutoff. */
const PRUNABLE_RUNS = `r.status = ANY($2::text[]) AND ${RUN_AGE} < $1`;

export async function prune(pool: Pool, args: PruneArgs): Promise<PruneResult> {
  const olderThanMs = args.olderThanMs;
  if (!Number.isFinite(olderThanMs) || olderThanMs < MIN_RETENTION_MS) {
    throw new KernelError(
      'bad_request',
      `retention must be at least ${MIN_RETENTION_MS}ms, got ${olderThanMs}`,
    );
  }
  const dryRun = args.dryRun ?? false;
  const batchSize = args.batchSize ?? PRUNE_BATCH;
  const cutoff = new Date(Date.now() - olderThanMs);

  const result = dryRun
    ? await countPrunable(pool, cutoff)
    : await deletePrunable(pool, cutoff, batchSize);
  result.workers = await pruneWorkers(pool, cutoff, dryRun);
  return result;
}

/* ---------------------------------------------------------------------------
 * dry run — read-only
 * ------------------------------------------------------------------------- */

/**
 * What a real prune would remove, without removing it. One statement: the
 * dependent counts are correlated sub-selects over the same run set, so the
 * report can never describe a different set than the one it counted.
 */
async function countPrunable(pool: Pool, cutoff: Date): Promise<PruneResult> {
  const res = await pool.query<{
    runs: string;
    run_steps: string;
    logs: string;
    waits: string;
    queue: string;
  }>(
    `WITH doomed AS (SELECT r.id FROM runs r WHERE ${PRUNABLE_RUNS})
     SELECT (SELECT count(*) FROM doomed)                                          AS runs,
            (SELECT count(*) FROM run_steps WHERE run_id IN (SELECT id FROM doomed)) AS run_steps,
            (SELECT count(*) FROM logs      WHERE run_id IN (SELECT id FROM doomed)) AS logs,
            (SELECT count(*) FROM waits     WHERE run_id IN (SELECT id FROM doomed)) AS waits,
            (SELECT count(*) FROM queue     WHERE run_id IN (SELECT id FROM doomed)) AS queue`,
    [cutoff, TERMINAL_STATUSES],
  );
  const row = res.rows[0];
  return {
    ...emptyResult(cutoff, true),
    runs: num(row?.runs),
    runSteps: num(row?.run_steps),
    logs: num(row?.logs),
    waits: num(row?.waits),
    queue: num(row?.queue),
  };
}

/* ---------------------------------------------------------------------------
 * the real thing
 * ------------------------------------------------------------------------- */

/**
 * Delete prunable runs in batches until a batch comes back short. Each batch
 * is one transaction; the loop terminates because every batch either deletes
 * its rows (shrinking the candidate set) or finds fewer than `batchSize` and
 * stops.
 */
async function deletePrunable(
  pool: Pool,
  cutoff: Date,
  batchSize: number,
): Promise<PruneResult> {
  const total = emptyResult(cutoff, false);
  for (;;) {
    const batch = await deleteBatch(pool, cutoff, batchSize);
    total.runs += batch.runs;
    total.runSteps += batch.runSteps;
    total.logs += batch.logs;
    total.waits += batch.waits;
    total.queue += batch.queue;
    if (batch.runs < batchSize) return total;
  }
}

async function deleteBatch(
  pool: Pool,
  cutoff: Date,
  batchSize: number,
): Promise<PruneResult> {
  return withTx(pool, async (client) => {
    const batch = emptyResult(cutoff, false);
    // Oldest first, so an interrupted prune leaves the newest history behind —
    // and so the next batch is strictly closer to the cutoff.
    const ids = await client.query<{ id: string }>(
      `SELECT r.id FROM runs r
        WHERE ${PRUNABLE_RUNS}
        ORDER BY ${RUN_AGE} ASC
        LIMIT $3`,
      [cutoff, TERMINAL_STATUSES, batchSize],
    );
    const runIds = ids.rows.map((r) => r.id);
    if (runIds.length === 0) return batch;

    // Counted before the delete, inside the same transaction, because the FK
    // cascade reports nothing back: `DELETE FROM runs` returns the number of
    // *runs* it removed and stays silent about the rows that followed. This is
    // the only way the report can say how much log volume actually went.
    const counts = await client.query<{ run_steps: string; logs: string }>(
      `SELECT (SELECT count(*) FROM run_steps WHERE run_id = ANY($1::text[])) AS run_steps,
              (SELECT count(*) FROM logs      WHERE run_id = ANY($1::text[])) AS logs`,
      [runIds],
    );
    batch.runSteps = num(counts.rows[0]?.run_steps);
    batch.logs = num(counts.rows[0]?.logs);

    // waits / queue have no FK to runs, so they are deleted by hand. Both are
    // normally already empty for a terminal run (the queue row goes on the
    // terminal transition, waits are resolved) — this is what keeps a run that
    // ended some other way from leaving a dangling row behind.
    //
    // Order matters, and it is the canonical one from runs.ts: queue (position
    // 1) → runs (position 2) → waits (position 3). The rows this touches are
    // meant to be absent, but "meant to be" is exactly the case this code exists
    // for, so it takes its locks in the same order every other multi-row tx does
    // rather than relying on the candidate set being disjoint from scanWaits'.
    // Deleting runs before waits is safe in either direction here — waits has no
    // FK to runs, so no constraint sees the intermediate state inside this tx.
    const queued = await client.query(`DELETE FROM queue WHERE run_id = ANY($1::text[])`, [
      runIds,
    ]);
    batch.queue = num(queued.rowCount);

    // run_steps + logs go with it, in the database, by the 0007 cascade.
    const runs = await client.query(`DELETE FROM runs WHERE id = ANY($1::text[])`, [runIds]);
    batch.runs = num(runs.rowCount);

    const waits = await client.query(`DELETE FROM waits WHERE run_id = ANY($1::text[])`, [
      runIds,
    ]);
    batch.waits = num(waits.rowCount);
    return batch;
  });
}

/**
 * Offline worker rows past the cutoff. Only 'offline' ones: a worker whose
 * heartbeat is merely stale is the offline marker loop's business, and deleting
 * a row the marker is about to update would hide a daemon that is actually
 * still running from the dashboard.
 */
async function pruneWorkers(pool: Pool, cutoff: Date, dryRun: boolean): Promise<number> {
  if (dryRun) {
    const res = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM workers
        WHERE status = 'offline' AND last_heartbeat_at < $1`,
      [cutoff],
    );
    return num(res.rows[0]?.count);
  }
  const res = await pool.query(
    `DELETE FROM workers WHERE status = 'offline' AND last_heartbeat_at < $1`,
    [cutoff],
  );
  return num(res.rowCount);
}
