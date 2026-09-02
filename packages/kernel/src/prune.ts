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
       the run row IS deleting its logs and its step timeline; migration 0011
       (C5) extended the same cascade to `queue` and `waits`, so deleting the
       run row is the whole delete — the only per-table SQL left is the queue
       DELETE ahead of the runs DELETE, which exists purely to take the queue
       rows in canonical lock order (position 1 before position 2, see runs.ts
       header) instead of letting the 0011 cascade reach them from behind the
       runs lock, where the reaper could deadlock against it;
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

   Candidate-scan trade-off (p2-10 C6): the candidate predicate orders and
   filters on `COALESCE(finished_at, updated_at)`, which no index can serve —
   every batch filters + sorts over the terminal rows. Pruning is a
   low-frequency housekeeping path, so that is accepted today; if it ever is
   not, a partial index `(project_id, env, finished_at) WHERE status IN
   (terminal)` makes the scan index-bound.

   `dryRun` reports exactly what a real run would remove and issues no DELETE
   at all — the counting path is a separate, read-only set of queries, so the
   flag cannot be defeated by a code path that deletes first and counts after.
   ============================================================================= */
import type { Pool } from 'pg';
import {
  KernelError,
  type Namespace,
} from '@better-trigger/core';
import { withTx } from './runs';
import { assertNamespaces, namespacePredicate, TERMINAL_STATUSES } from './queue';

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
  /**
   * Namespaces to prune (C2): a pruner only ever deletes runs inside these
   * pairs — it can never remove another namespace's history.
   */
  namespaces: readonly Namespace[];
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
  /** waits rows resolved by the prune — deleted via the run_id cascade, or
   *  their child_run_id SET NULL via the child FK (0011); counted in both
   *  directions (a row referencing two doomed runs counts once). */
  waits: number;
  /** queue rows that went with them (deleted explicitly, or via the FK cascade). */
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

/** WHERE clause selecting prunable runs. $1 = cutoff, $2 = statuses. */
const PRUNABLE_RUNS = `r.status = ANY($2::text[]) AND ${RUN_AGE} < $1`;

export async function prune(pool: Pool, args: PruneArgs): Promise<PruneResult> {
  const olderThanMs = args.olderThanMs;
  if (!Number.isFinite(olderThanMs) || olderThanMs < MIN_RETENTION_MS) {
    throw new KernelError(
      'bad_request',
      `retention must be at least ${MIN_RETENTION_MS}ms, got ${olderThanMs}`,
    );
  }
  assertNamespaces(args.namespaces);
  const dryRun = args.dryRun ?? false;
  const batchSize = args.batchSize ?? PRUNE_BATCH;
  // Same floor discipline as olderThanMs above. `batchSize: 0` is the dangerous
  // one: the candidate SELECT gets `LIMIT 0`, deleteBatch returns 0 runs, and
  // the loop terminator `batch.runs < batchSize` (0 < 0) is never true — the
  // GC loop spins forever on one pool connection and retention never runs
  // again. A negative one reaches pg as `LIMIT -5` (a bare error), a fractional
  // one as a truncated LIMIT — all are caller bugs, so refuse rather than obey.
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new KernelError(
      'bad_request',
      `batchSize must be an integer of at least 1, got ${batchSize}`,
    );
  }
  const cutoff = new Date(Date.now() - olderThanMs);

  const result = dryRun
    ? await countPrunable(pool, cutoff, args.namespaces)
    : await deletePrunable(pool, cutoff, batchSize, args.namespaces);
  result.workers = await pruneWorkers(pool, cutoff, dryRun, args.namespaces);
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
async function countPrunable(
  pool: Pool,
  cutoff: Date,
  namespaces: readonly Namespace[],
): Promise<PruneResult> {
  // $1 cutoff / $2 statuses (PRUNABLE_RUNS) are literal in the SQL; the
  // namespace pairs continue from $3 in the same array (see namespacePredicate).
  const params: unknown[] = [cutoff, TERMINAL_STATUSES];
  const nsPredicate = namespacePredicate('r', namespaces, params);
  const res = await pool.query<{
    runs: string;
    run_steps: string;
    logs: string;
    waits: string;
    queue: string;
  }>(
    `WITH doomed AS (SELECT r.id FROM runs r WHERE ${PRUNABLE_RUNS} AND ${nsPredicate})
     SELECT (SELECT count(*) FROM doomed)                                          AS runs,
            (SELECT count(*) FROM run_steps WHERE run_id IN (SELECT id FROM doomed)) AS run_steps,
            (SELECT count(*) FROM logs      WHERE run_id IN (SELECT id FROM doomed)) AS logs,
            (SELECT count(*) FROM waits
              WHERE run_id IN (SELECT id FROM doomed)
                 OR child_run_id IN (SELECT id FROM doomed))                        AS waits,
            (SELECT count(*) FROM queue     WHERE run_id IN (SELECT id FROM doomed)) AS queue`,
    params,
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
  namespaces: readonly Namespace[],
): Promise<PruneResult> {
  const total = emptyResult(cutoff, false);
  for (;;) {
    const batch = await deleteBatch(pool, cutoff, batchSize, namespaces);
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
  namespaces: readonly Namespace[],
): Promise<PruneResult> {
  return withTx(pool, async (client) => {
    const batch = emptyResult(cutoff, false);
    // Oldest first, so an interrupted prune leaves the newest history behind —
    // and so the next batch is strictly closer to the cutoff. The candidate
    // set is namespace-scoped: ids from this SELECT are the only ids the
    // dependent deletes below ever touch, so they stay in-namespace too (C2).
    // $1 cutoff / $2 statuses (PRUNABLE_RUNS) and $3 batchSize (LIMIT) are
    // literal in the SQL; the namespace pairs continue from $4 in the same
    // array (see namespacePredicate).
    const params: unknown[] = [cutoff, TERMINAL_STATUSES, batchSize];
    const nsPredicate = namespacePredicate('r', namespaces, params);
    const ids = await client.query<{ id: string }>(
      `SELECT r.id FROM runs r
        WHERE ${PRUNABLE_RUNS} AND ${nsPredicate}
        ORDER BY ${RUN_AGE} ASC
        LIMIT $3`,
      params,
    );
    const runIds = ids.rows.map((r) => r.id);
    if (runIds.length === 0) return batch;

    // Counted before the delete, inside the same transaction, because the FK
    // cascade reports nothing back: `DELETE FROM runs` returns the number of
    // *runs* it removed and stays silent about the rows that followed. This is
    // the only way the report can say how much log volume actually went —
    // and, since 0011, how many waits/queue rows went too.
    //
    // waits is counted in BOTH directions: run_id = ANY(...) rows are deleted
    // by the run_id FK cascade, child_run_id = ANY(...) rows are SET NULL by
    // the child FK (0011) — one wait referencing two doomed runs counts once
    // (OR, not +). The report's `waits` figure means "waits this prune
    // resolved, deleted or orphaned-child cleared".
    const counts = await client.query<{
      run_steps: string;
      logs: string;
      waits: string;
      queue: string;
    }>(
      `SELECT (SELECT count(*) FROM run_steps WHERE run_id = ANY($1::text[])) AS run_steps,
              (SELECT count(*) FROM logs      WHERE run_id = ANY($1::text[])) AS logs,
              (SELECT count(*) FROM waits
                WHERE run_id = ANY($1::text[])
                   OR child_run_id = ANY($1::text[]))                          AS waits,
              (SELECT count(*) FROM queue     WHERE run_id = ANY($1::text[])) AS queue`,
      [runIds],
    );
    batch.runSteps = num(counts.rows[0]?.run_steps);
    batch.logs = num(counts.rows[0]?.logs);
    batch.waits = num(counts.rows[0]?.waits);
    batch.queue = num(counts.rows[0]?.queue);

    // The 0011 FKs cascade waits (and, redundantly, queue) off the runs
    // DELETE below, so no hand-written dependent delete is needed — "delete a
    // run" means the same thing everywhere, manual psql DELETE included. The
    // one statement that stays is this queue DELETE, taken FIRST on purpose:
    // it is the canonical lock-order position 1 (runs.ts header). If the
    // cascade were left to delete the queue rows from behind the runs lock, a
    // concurrent reaper that already holds a queue row of this batch (SKIP
    // LOCKED) could block our cascade while we hold the runs row it wants —
    // a deadlock that the queue-first order cannot reach.
    await client.query(`DELETE FROM queue WHERE run_id = ANY($1::text[])`, [runIds]);

    // run_steps + logs + waits go with it, in the database, by the 0007/0011
    // cascades.
    const runs = await client.query(`DELETE FROM runs WHERE id = ANY($1::text[])`, [runIds]);
    batch.runs = num(runs.rowCount);
    return batch;
  });
}

/**
 * Offline worker rows past the cutoff, scoped to workers that serve at least
 * one of the given namespaces (C2 — a pruner never deletes a row that never
 * served its namespaces). Only 'offline' ones: a worker whose heartbeat is
 * merely stale is the offline marker loop's business, and deleting a row the
 * marker is about to update would hide a daemon that is actually still running
 * from the dashboard.
 */
async function pruneWorkers(
  pool: Pool,
  cutoff: Date,
  dryRun: boolean,
  namespaces: readonly Namespace[],
): Promise<number> {
  // OR semantics, VALUES pairing: a worker serving ANY of the prune namespaces
  // is in scope (jsonb `@>` would require ALL of them).
  const nsParams: unknown[] = [];
  const start = 2;
  const values = namespaces
    .map((_, i) => `($${start + i * 2}::text, $${start + i * 2 + 1}::text)`)
    .join(', ');
  for (const ns of namespaces) nsParams.push(ns.projectId, ns.env);
  const nsScope = `EXISTS (
      SELECT 1 FROM jsonb_array_elements(w.namespaces) n
       WHERE (n->>'projectId', n->>'env') IN (VALUES ${values})
    )`;
  if (dryRun) {
    const res = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM workers w
        WHERE status = 'offline' AND last_heartbeat_at < $1 AND ${nsScope}`,
      [cutoff, ...nsParams],
    );
    return num(res.rows[0]?.count);
  }
  const res = await pool.query(
    `DELETE FROM workers w WHERE status = 'offline' AND last_heartbeat_at < $1 AND ${nsScope}`,
    [cutoff, ...nsParams],
  );
  return num(res.rowCount);
}
