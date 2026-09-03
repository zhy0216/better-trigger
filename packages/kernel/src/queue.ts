/* =============================================================================
   @better-trigger/kernel — kernel queue engine.
   Enqueue / SKIP-LOCKED claim (with per-task concurrency limiting + lease and
   fencing token) / lease renewal / claim release on shutdown.
   See docs/backend-contract.md §3.5.
   Implemented with raw SQL over a single pg connection/transaction so the
   SELECT ... FOR UPDATE SKIP LOCKED semantics are exact. The pool is injected
   by createKernel() — no module-global connection.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import {
  assertNamespace,
  KernelError,
  type ClaimedRun,
  type Namespace,
  type StepSnapshot,
} from '@better-trigger/core';
import type { KernelLogger } from './kernel';
import { notifyWork } from './notify';

/**
 * How long a worker row may go without a heartbeat and still count as live.
 * ONE constant drives every "is this worker still there" reading — the
 * stranded-run scan below, the cron served-check (orchestrator.ts
 * servedTaskIds), the registration takeover guard (workers.ts) — plus the
 * offline marker loop (orchestrator.ts markOfflineWorkers): a row past this
 * window is treated as gone by all of them at once, so the observation
 * surfaces cannot disagree about a worker that stopped heartbeating. Every
 * SQL window binds it as `($n::text || ' milliseconds')::interval` (never a
 * literal), the way markOfflineWorkers always has, so the SQL and the
 * constant cannot drift.
 */
export const WORKER_OFFLINE_MS = 120_000;

export interface EnqueueArgs {
  runId: string;
  availableAt: Date;
  priority?: number;
  concurrencyKey: string | null;
  /** The namespace the run lives in — stamped on the queue row so every
   *  claim/lease/heartbeat statement can re-scope on it (C2). */
  namespace: Namespace;
  /**
   * Preserve a SURVIVING queue row's priority/concurrency_key on the conflict
   * branch instead of overwriting them with the new values. Default false.
   * `enqueue()`'s default overwrite is right for a fresh trigger (the new
   * values ARE the truth); the wait-resume path passes true because reaching
   * the conflict branch there means a queue row survived the suspend, and that
   * row's own priority is the more trustworthy value (p2-30).
   */
  preserveSurvivor?: boolean;
}

/**
 * Build a namespace filter, appending the flattened values to `params`.
 *
 * - ONE namespace → two constant equalities
 *   (`alias.project_id = $n::text AND alias.env = $n+1::text`). Postgres only
 *   flattens a single-row VALUES into constant equalities when it feels like
 *   it; writing them outright guarantees the (project_id, env) prefix of the
 *   scoped indexes (queue_claimable_idx etc.) binds as constants instead of
 *   depending on the planner's VALUES handling.
 * - TWO+ namespaces → the VALUES pairing form
 *   (`(alias.project_id, alias.env) IN (VALUES ($n::text, $n+1::text), …)`).
 *   The pairing is deliberate: two separate `= ANY` arrays would combine in a
 *   cartesian product, so a worker serving (p1, e1) and (p2, e2) could match a
 *   run in (p1, e2) it does not actually serve. This is what the cold paths
 *   (waits/cron/reaper/prune/stranded scans) use — a semi-join over a couple
 *   of pairs is fine there, it is the claim hot loop that must not.
 */
export function namespacePredicate(
  alias: string,
  namespaces: readonly Namespace[],
  params: unknown[],
): string {
  if (namespaces.length === 1) return nsPredicateFor(alias, namespaces[0]!, params);
  const start = params.length + 1;
  const values = namespaces
    .map((_, i) => `($${start + i * 2}::text, $${start + i * 2 + 1}::text)`)
    .join(', ');
  for (const ns of namespaces) params.push(ns.projectId, ns.env);
  return `(${alias}.project_id, ${alias}.env) IN (VALUES ${values})`;
}

/**
 * Build the single-namespace equality form
 * (`alias.project_id = $n::text AND alias.env = $n+1::text`), appending the
 * pair to `params`. For per-namespace hot loops (claimRuns scans one namespace
 * at a time): constant equalities make the leading (project_id, env) columns of
 * the scoped indexes bind directly, with no reliance on the planner flattening
 * a VALUES list (p1-08).
 */
export function nsPredicateFor(alias: string, ns: Namespace, params: unknown[]): string {
  const start = params.length + 1;
  params.push(ns.projectId, ns.env);
  return `${alias}.project_id = $${start}::text AND ${alias}.env = $${start + 1}::text`;
}

/** Validate a non-empty namespace list at the worker-facing API boundary. */
export function assertNamespaces(namespaces: readonly Namespace[]): void {
  if (!Array.isArray(namespaces) || namespaces.length === 0) {
    throw new KernelError('bad_request', 'namespaces must be a non-empty array');
  }
  for (const ns of namespaces) assertNamespace(ns);
}

/**
 * Insert (or move-back) a run into the queue. Idempotent on run_id (runs.id
 * stays globally unique — the namespace is a scoping predicate, not a key
 * component). The conflict path clears locked_by/locked_at/lease_until (NULL
 * lease = unoccupied). The fencing token lives on the runs row — queue rows are
 * deleted and re-inserted across suspend/resume, so the watermark must not
 * (and does not) travel with them.
 */
export async function enqueue(client: PoolClient, args: EnqueueArgs): Promise<void> {
  await enqueueMany(client, [args]);
}

/**
 * The same INSERT as enqueue, but for many runs in ONE statement (PF5) — the
 * batch-trigger fan-out used to cost one round trip per item, which is exactly
 * the long-write-tx problem the batch byte cap exists for. Per-row semantics
 * are identical to enqueue (ON CONFLICT (run_id) DO UPDATE clears a stale
 * claim; the fencing token is untouched either way).
 */
export async function enqueueMany(client: PoolClient, args: EnqueueArgs[]): Promise<void> {
  if (args.length === 0) return;
  const start = 1;
  const values = args
    .map(
      (_, i) =>
        `($${start + i * 6}, $${start + i * 6 + 1}, $${start + i * 6 + 2}, ` +
        `$${start + i * 6 + 3}, $${start + i * 6 + 4}, $${start + i * 6 + 5}, NULL, NULL)`,
    )
    .join(', ');
  // Two conflict semantics (p2-30): the default overwrites priority /
  // concurrency_key with the new values (a fresh trigger's values ARE the
  // truth); `preserveSurvivor` only reschedules the survivor and keeps ITS
  // priority/concurrency_key (the wait-resume case — a queue row that survived
  // the suspend knows better than the resume).
  const hasPreserve = args.some((a) => a.preserveSurvivor);
  const hasOverwrite = args.some((a) => !a.preserveSurvivor);
  if (hasPreserve && hasOverwrite) {
    // One statement carries ONE conflict semantics: mixing the two here used
    // to route every row through a single branch, silently giving half the
    // batch the wrong meaning. Refuse up front instead (p2-10 C2).
    throw new KernelError(
      'bad_request',
      'enqueueMany: cannot mix preserve and overwrite conflict semantics in one batch — ' +
        'make every item preserveSurvivor, or none (split the batch to use both)',
    );
  }
  const conflict = hasPreserve
    ? `ON CONFLICT (run_id) DO UPDATE
         SET available_at = EXCLUDED.available_at,
             locked_by = NULL, locked_at = NULL, lease_until = NULL`
    : `ON CONFLICT (run_id) DO UPDATE
         SET available_at = EXCLUDED.available_at,
             priority = EXCLUDED.priority,
             concurrency_key = EXCLUDED.concurrency_key,
             locked_by = NULL, locked_at = NULL, lease_until = NULL`;
  await client.query(
    `INSERT INTO queue (run_id, available_at, priority, concurrency_key, project_id, env, locked_by, locked_at)
     VALUES ${values}
     ${conflict}`,
    args.flatMap((a) => [
      a.runId,
      a.availableAt,
      a.priority ?? 0,
      a.concurrencyKey,
      a.namespace.projectId,
      a.namespace.env,
    ]),
  );
}

/** Remove a run's queue row (used on suspend / terminal). Scoped to the run's
 *  namespace so one namespace can never delete another's queue row. */
export async function removeFromQueue(
  db: Pool | PoolClient,
  runId: string,
  namespace: Namespace,
): Promise<void> {
  await db.query(
    `DELETE FROM queue WHERE run_id = $1 AND project_id = $2 AND env = $3`,
    [runId, namespace.projectId, namespace.env],
  );
}

export interface ClaimRunsArgs {
  workerId: string;
  /**
   * Namespaces this worker serves. The candidate scan filters runs by the
   * (project_id, env) pairs (VALUES pairing, not separate ANY arrays) — a
   * staging worker can never claim a prod run (C2).
   */
  namespaces: readonly Namespace[];
  /** Task ids this worker can execute (filtered in SQL). */
  taskIds: string[];
  /** Maximum runs to claim in this call. */
  limit: number;
  /** Lease duration granted per claimed run (renewed by heartbeat). */
  leaseMs: number;
  /**
   * Version pinning (`--pin-code-version`): the code version this worker serves
   * for each entry of `taskIds`, **positionally parallel to it**. Present ⇒ a
   * run is only a candidate if its `code_version` matches the version this
   * worker has for that task (or is NULL — see below). Absent ⇒ no version
   * predicate at all, the historical behaviour where any worker registered for
   * the task claims any of its runs.
   *
   * Why it exists: replay keys steps by position, so a run whose task was
   * edited mid-flight has a ledger the new code may no longer line up with
   * (executor.ts `cached()`). Pinning keeps such a run queued for a worker that
   * can still replay it instead of handing it to code that will drift.
   *
   * `code_version IS NULL` is claimable by anyone on purpose: it means the run
    * was created before its task was ever registered, so there is no version to
    * honour and no ledger written against one.
    */
  codeVersions?: string[];
  /**
   * Cap on the replayed step ledger per claimed run (env BETTER_TRIGGER_MAX_STEPS).
   * 0/undefined = unlimited (backward compatible). When exceeded, the run is
   * claimed but marked `stepsTruncated` so the worker fails it non-retryably —
   * the ledger read runs OUTSIDE the claim transaction and reads `maxSteps + 1`
   * rows to detect overflow without a second count.
   */
  maxSteps?: number;
  /**
   * Sink for stale-candidate diagnostics (p2-39): a candidate whose runs row
   * is not 'queued' anymore is skipped, and the skip is worth saying out loud —
   * such a row can only exist if some path desynced queue from runs. Defaults
   * to console.
   */
  logger?: KernelLogger;
  /**
   * Index of the namespace the candidate scan starts at (P0-14). The scan
   * walks `namespaces` in rotation order starting here, and the shared
   * `limit` is consumed in that order — pinned to index 0, a worker whose
   * `namespaces[0]` always has claimable runs would never scan the rest of
   * the list, starving them forever. The CALLER owns the rotation state (the
   * runtime advances it once per claim), so the kernel stays a pure function
   * of its arguments. Any integer is accepted (normalized into
   * [0, namespaces.length), negatives counted from the end); undefined = 0,
   * the historical order.
   */
  rotateFrom?: number;
  /**
   * Invoked when the shared `limit` budget was met before every namespace in
   * the rotation order got a candidate scan (P0-14): the callback receives
   * the namespaces that were NOT scanned this call, in scan order. Purely
   * observational — bounded fairness comes from `rotateFrom` (a skipped
   * namespace leads the order within `namespaces.length` calls); this is the
   * number behind the skip, so "one namespace is always behind the budget"
   * is visible the way claim errors are. Not called when nothing was
   * skipped. Called AFTER the claim transaction commits, and an observer
   * that throws only earns a warn — it can never roll back or fail a claim.
   */
  onScanSkipped?: (skipped: readonly Namespace[]) => void;
}

/**
 * `classid` of the concurrency limiter's advisory locks, spelling 'btcc'
 * (better-trigger concurrency control) — todos/02-performance.md PF7.
 *
 * Advisory locks live in one namespace shared by the whole database, and the
 * one-argument form this used to take (`pg_advisory_xact_lock(hashtext(key))`)
 * put better-trigger's keys in the same space as any `pg_advisory_lock` the
 * application owning the database takes for its own reasons — a documented
 * deployment (daemon sharing the app's database) where an unrelated lock could
 * silently serialize our claims. The two-argument form's (classid, objid) space
 * is disjoint from the one-argument bigint space and, with a classid nobody
 * else picks, ours alone. Collision odds *within* better-trigger are unchanged
 * (objid is still the 32-bit hashtext of the key, so two concurrency keys can
 * still hash together and serialize each other), but `pg_locks` now names the
 * owner: classid 1651794787 is this limiter and nothing else.
 *
 * Deliberately NOT the migration lock's class (`LOCK_CLASS` = 'btmg',
 * packages/db/src/migrate.ts): different classid ⇒ different objid space, so
 * the two can never meet however their objids hash. They are also different
 * kinds of lock — this one is *transaction*-scoped (released by COMMIT/ROLLBACK
 * of the claim transaction, never unlocked by hand), the migration's is
 * *session*-scoped and pinned to one client. Do not mix the two forms on the
 * same key.
 */
export const CONCURRENCY_LOCK_CLASS = 0x62_74_63_63; // 'btcc'

/**
 * Terminal run statuses — one-way states no recovery/claim path may ever
 * transition a run out of (p2-39). A queue row left behind by one of these
 * (or by a 'waiting' run) is residue, deleted under the lock already held.
 */
export const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'];

/**
 * Size of the candidate window the claim transaction locks, derived from the
 * caller's `limit` (todos/02-performance.md PF3).
 *
 * The window has to be wider than `limit` because a candidate can be dropped
 * after it is locked: the per-task concurrency limit below skips rows whose key
 * is already at its cap, and a run whose row vanished is skipped too. With a
 * window of exactly `limit`, a queue whose head happens to be full of capped
 * runs would return nothing while perfectly claimable runs sat one row further
 * down. Doubling gives that skipping room; the floor of 10 keeps the common
 * `limit: 1` slot poll from degenerating into "look at the single head row".
 *
 * It must not be much wider either — every row in the window is held
 * `FOR UPDATE SKIP LOCKED` for the whole transaction, so anything locked and
 * not taken is a row hidden from other workers (and, since they skip it, a
 * dent in the global priority order). `2x` is the smallest multiplier that
 * tolerates skipping at all.
 */
export function claimWindow(limit: number): number {
  return Math.max(limit * 2, 10);
}

/**
 * Upper bound on a single claim's `limit`. The candidate scan holds
 * `claimWindow(limit)` queue rows `FOR UPDATE SKIP LOCKED` for the whole claim
 * transaction, so an unbounded `limit` is precisely the long-write-transaction
 * the batch caps exist to prevent: `limit: 1_000_000` would pin up to two
 * million rows from every peer worker. The runtime claims one run per slot
 * (limit 1); anything at this ceiling already holds the window for a second.
 */
export const MAX_CLAIM_LIMIT = 500;

interface PendingClaim {
  runId: string;
  taskId: string;
  payload: unknown;
  attempt: number;
  maxAttempts: number;
  codeVersion: string | null;
  projectId: string;
  env: string;
  fencingToken: number;
}

type Candidate = {
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
};

/**
 * Runs the per-namespace candidate scans, filling `pending` up to `args.limit`.
 * Returns the namespaces the rotation order did not reach before the budget
 * filled (empty when every namespace was scanned) — the CALLER reports them
 * via `onScanSkipped`, after the claim tx commits, so an observer can never
 * run inside (or roll back) the transaction.
 */
async function scanCandidates(
  client: PoolClient,
  args: ClaimRunsArgs,
  pinned: boolean,
  codeVersions: string[],
  pending: PendingClaim[],
  logger: KernelLogger,
): Promise<Namespace[]> {
  // The candidate scan runs once per namespace (p1-08). `JOIN runs` is an
  // inner join, so a queue row whose run vanished is simply not a candidate
  // (it was skipped by the old per-row read too). `r.status = 'queued'` is
  // the claimability predicate itself (p2-39): a queue row can only ever be
  // claimed while its run is still queued — a terminal/desynced run's
  // leftover row is invisible here, never resurrected. `LEFT JOIN tasks`
  // because a run may reference a task row that was never registered — that
  // means "no concurrency limit", not "not claimable".
  //
  // Pinned, the task filter becomes a join against the (id, version) pairs
  // this worker serves rather than an id-only `= ANY`, so the predicate is
  // per task: task A can be at v2 here while task B is still at v1. Filtering
  // in SQL and not in the loop is what keeps the window honest — a window
  // full of other-version rows would otherwise report "nothing to claim"
  // while claimable runs sat one row further down. Locking is unchanged:
  // `FOR UPDATE OF q` still names the queue row and nothing else, and the CTE
  // is a values list, not a lockable relation.
  //
  // Each namespace's scan puts its predicate on `q` (constant equalities —
  // `queue_claimable_idx` binds on its (project_id, env) leading columns) and
  // repeats the equality against `r` so the semantics are explicit, not
  // smuggled through the join's `r.project_id = q.project_id AND r.env =
  // q.env`. Params are numbered in ONE array, in SQL order: the task ids /
  // window / code versions come first (their $n are written literally in the
  // SQL below), and nsPredicateFor() numbers the namespace pair from the next
  // free slot — a fresh array here would restart at $1 and collide with the
  // literal placeholders above it. The `r`-side equality references the SAME
  // pair. The limit is shared sequentially in scan order: once the budget is
  // filled, the namespaces the rotation order has not reached yet get no scan
  // THIS call and are returned for the caller to report via `onScanSkipped`
  // (after the tx commits). That skip is bounded, not
  // permanent (P0-14): the caller rotates `rotateFrom`, so every namespace
  // leads the scan order within `namespaces.length` calls and a busy first
  // namespace can never monopolize the budget.
  const n = args.namespaces.length;
  const rawStart = args.rotateFrom ?? 0;
  const start = Number.isFinite(rawStart)
    ? ((Math.trunc(rawStart) % n) + n) % n
    : 0;
  for (let i = 0; i < n; i += 1) {
    const remaining = args.limit - pending.length;
    if (remaining <= 0) {
      return Array.from({ length: n - i }, (_, j) => args.namespaces[(start + i + j) % n]!);
    }
    const ns = args.namespaces[(start + i) % n]!;

    const params: unknown[] = pinned
      ? [args.taskIds, claimWindow(remaining), codeVersions]
      : [args.taskIds, claimWindow(remaining)];
    const qPredicate = nsPredicateFor('q', ns, params);
    const rStart = params.length - 1;
    const rPredicate = `r.project_id = $${rStart}::text AND r.env = $${rStart + 1}::text`;
    const candidates = await client.query<Candidate>(
      pinned
        ? `WITH serving(task_id, code_version) AS (
             SELECT DISTINCT * FROM unnest($1::text[], $3::text[])
           )
           SELECT q.id AS queue_id, q.run_id,
                  r.task_id, r.payload, r.attempt, r.max_attempts,
                  r.code_version, r.project_id, r.env, r.concurrency_key,
                  t.concurrency_limit
             FROM queue q
             JOIN runs r ON r.id = q.run_id
                        AND r.project_id = q.project_id AND r.env = q.env
             JOIN serving s ON s.task_id = r.task_id
             LEFT JOIN tasks t ON t.id = r.task_id
                            AND t.project_id = r.project_id AND t.env = r.env
            WHERE q.available_at <= now() AND q.locked_by IS NULL
              AND r.status = 'queued'
              AND ${qPredicate}
              AND ${rPredicate}
              AND (r.code_version IS NULL OR r.code_version = s.code_version)
            ORDER BY q.priority DESC, q.id ASC
            LIMIT $2
            FOR UPDATE OF q SKIP LOCKED`
        : `SELECT q.id AS queue_id, q.run_id,
                  r.task_id, r.payload, r.attempt, r.max_attempts,
                  r.code_version, r.project_id, r.env, r.concurrency_key,
                  t.concurrency_limit
             FROM queue q
             JOIN runs r ON r.id = q.run_id
                        AND r.project_id = q.project_id AND r.env = q.env
             LEFT JOIN tasks t ON t.id = r.task_id
                            AND t.project_id = r.project_id AND t.env = r.env
            WHERE q.available_at <= now() AND q.locked_by IS NULL
              AND r.status = 'queued'
              AND ${qPredicate}
              AND ${rPredicate}
              AND r.task_id = ANY($1::text[])
            ORDER BY q.priority DESC, q.id ASC
            LIMIT $2
            FOR UPDATE OF q SKIP LOCKED`,
      params,
    );

    for (const cand of candidates.rows) {
      if (pending.length >= args.limit) break;
      const claim = await tryClaimOne(client, args, cand, logger);
      if (claim !== null) pending.push(claim);
    }
  }
  return [];
}

async function tryClaimOne(
  client: PoolClient,
  args: ClaimRunsArgs,
  cand: Candidate,
  logger: KernelLogger,
): Promise<PendingClaim | null> {
  // Concurrency limit: the task's limit came back with the candidate; if set,
  // count running runs sharing the same concurrency_key (redundantly stored
  // on runs). The lock key and the count are both namespace-scoped, so
  // prod and staging throttle independently (C2).
  const limit = cand.concurrency_limit;
  if (limit != null && limit > 0) {
    const key = cand.concurrency_key ?? cand.task_id;
    // Serialize concurrent claims sharing this key: SKIP LOCKED does not
    // serialize two workers picking different queue rows of the same key, so
    // the count-then-flip below could race and overshoot the limit. Take a
    // tx-level advisory lock on the key first; it releases at COMMIT/ROLLBACK
    // and must be held while we count (same transaction). Two-argument form
    // so the key sits in better-trigger's own lock space — see
    // CONCURRENCY_LOCK_CLASS above.
    await client.query(
      `SELECT pg_advisory_xact_lock($1::int4, hashtext($2))`,
      [CONCURRENCY_LOCK_CLASS, `bt:cc:${cand.project_id}:${cand.env}:${key}`],
    );
    const countRes = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM runs
        WHERE status = 'running' AND concurrency_key = $1
          AND project_id = $2 AND env = $3`,
      [key, cand.project_id, cand.env],
    );
    const running = Number(countRes.rows[0]?.n ?? '0');
    if (running >= limit) return null; // leave it in the queue
  }

  // Claim it: flip the run to running FIRST, guarded by the expected old
  // state (p2-39) — the queue row is already held (SKIP LOCKED, since the
  // scan), which is what serializes against every other path, so the
  // `status = 'queued'` predicate is belt-and-braces; a 0-row flip means
  // the candidate went stale (a terminal/desynced run with a leftover
  // queue row), and the claim must stop there: no lease, no ledger, no
  // fencing bump. The returned token is the claim's write credential —
  // any later claim invalidates it, and it survives suspend/resume
  // because it lives on runs, not on the delete-and-reinserted queue row.
  const tokenRes = await client.query<{ fencing_token: string }>(
    `UPDATE runs
        SET status = 'running',
            started_at = COALESCE(started_at, now()),
            updated_at = now(),
            fencing_token = fencing_token + 1
      WHERE id = $1 AND project_id = $2 AND env = $3 AND status = 'queued'
      RETURNING fencing_token`,
    [cand.run_id, cand.project_id, cand.env],
  );
  if (tokenRes.rowCount !== 1) {
    // The row exists but is not 'queued' anymore — a stale queue row
    // pointing at a run that already moved on (p2-39 §2). The queue row
    // is already held (position 1, taken by the candidate scan), so a
    // plain read of the run's status is race-free against every kernel
    // path: they all take the run's queue row before touching the run.
    // A terminal or 'waiting' run must carry no queue row — nothing will
    // ever pick this row up again — so delete it right here, under the
    // lock already held (no new lock, canonical order untouched). A
    // 'running' or 'queued' run means the flip was resolved elsewhere
    // (a live-claim race): its row is either someone's live claim or a
    // row another claim will retake — leave it alone. A missing run row
    // makes the queue row a ghost — delete it too (the reaper's rule).
    const st = await client.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1 AND project_id = $2 AND env = $3`,
      [cand.run_id, cand.project_id, cand.env],
    );
    const oldStatus = st.rows[0]?.status ?? 'missing';
    const removable =
      TERMINAL_STATUSES.includes(oldStatus) ||
      oldStatus === 'waiting' ||
      oldStatus === 'missing';
    if (removable) {
      await client.query(
        `DELETE FROM queue WHERE run_id = $1 AND project_id = $2 AND env = $3`,
        [cand.run_id, cand.project_id, cand.env],
      );
    }
    logger.warn(
      `[queue:claim] candidate queue row ${cand.queue_id} for run ${cand.run_id} ` +
        `is stale (runs.status '${oldStatus}', not 'queued') — claim skipped, run untouched` +
        (removable ? ', stale queue row deleted (source: claim)' : ''),
    );
    return null;
  }
  const fencingToken = Number(tokenRes.rows[0]!.fencing_token);

  // The lease, on the row the scan already holds (canonical position 1
  // was taken at scan time; this is a write, not a new lock).
  await client.query(
    `UPDATE queue
        SET locked_by = $1,
            locked_at = now(),
            lease_until = now() + ($2::text || ' milliseconds')::interval
      WHERE id = $3 AND project_id = $4 AND env = $5`,
    [args.workerId, String(args.leaseMs), cand.queue_id, cand.project_id, cand.env],
  );

  return {
    runId: cand.run_id,
    taskId: cand.task_id,
    payload: cand.payload,
    attempt: cand.attempt,
    maxAttempts: cand.max_attempts,
    codeVersion: cand.code_version,
    projectId: cand.project_id,
    env: cand.env,
    fencingToken,
  };
}

async function readLedger(
  client: PoolClient,
  args: ClaimRunsArgs,
  pending: readonly PendingClaim[],
): Promise<ClaimedRun[]> {
  // Phase 2 (p1-07): read each claimed run's step ledger OUTSIDE the
  // transaction, so the claim window's FOR UPDATE SKIP LOCKED rows were all
  // released the moment COMMIT ran — a fat ledger can no longer stall peer
  // workers while it materializes. The claim already holds the lease and the
  // bumped fencing token, and run_steps is append-only for a claimed run
  // (stale-fencing writes are rejected), so there is no torn state to read.
  // With a cap set, read maxSteps + 1 rows: overflow is then visible without
  // a second count, and the run is claimed but flagged stepsTruncated.
  const cap = args.maxSteps ?? 0;
  const stepsSql =
    cap > 0
      ? `SELECT seq, kind, label, status, output, error, fingerprint
           FROM run_steps WHERE run_id = $1 AND project_id = $2 AND env = $3
           ORDER BY seq ASC
           LIMIT $4`
      : `SELECT seq, kind, label, status, output, error, fingerprint
           FROM run_steps WHERE run_id = $1 AND project_id = $2 AND env = $3
           ORDER BY seq ASC`;
  const claimed: ClaimedRun[] = [];
  for (const p of pending) {
    const stepsParams: unknown[] = [p.runId, p.projectId, p.env];
    if (cap > 0) stepsParams.push(cap + 1);
    const stepsRes = await client.query<{
      seq: number;
      kind: string;
      label: string | null;
      status: string;
      output: unknown;
      error: unknown;
      fingerprint: string | null;
    }>(stepsSql, stepsParams);
    const steps: StepSnapshot[] = stepsRes.rows.map((s) => ({
      seq: s.seq,
      kind: s.kind as StepSnapshot['kind'],
      label: s.label,
      status: s.status as StepSnapshot['status'],
      output: s.output ?? undefined,
      error: (s.error as StepSnapshot['error']) ?? undefined,
      fingerprint: s.fingerprint ?? null,
    }));

    const run: ClaimedRun = {
      id: p.runId,
      taskId: p.taskId,
      payload: p.payload,
      attempt: p.attempt,
      maxAttempts: p.maxAttempts,
      codeVersion: p.codeVersion,
      projectId: p.projectId,
      env: p.env,
      steps,
      fencingToken: p.fencingToken,
    };
    if (cap > 0 && steps.length > cap) {
      // Overflow: the worker must fail this run non-retryably rather than
      // replay a ledger it could not fully see. Keep only the cap's worth of
      // rows so the shape stays valid (they will not be executed).
      run.stepsTruncated = true;
      run.steps = steps.slice(0, cap);
    }
    claimed.push(run);
  }

  return claimed;
}

/**
 * Claim up to `limit` runs for the given worker, in two phases:
 *
 * Phase 1 — the claim transaction:
 *   SELECT a claimWindow(remaining)-wide candidate set FOR UPDATE SKIP LOCKED
 *   (available + unclaimed + runs.status 'queued', by priority, task set
 *   filtered in SQL), for each candidate skip if the concurrency limit is hit,
 *   otherwise claim it: flip the run to running (guarded by status 'queued')
 *   and bump runs.fencing_token, then take the lease on the queue row
 *   (locked_by/locked_at + lease_until = now() + leaseMs) — the queue row was
 *   locked by the scan before the runs row, the canonical kernel lock order
 *   (see runs.ts header). A 0-row flip is a stale candidate and skips the
 *   lease and ledger entirely (p2-39). COMMIT.
 *
 * The candidate scan runs ONCE PER NAMESPACE (p1-08). One scan over the whole
 * `namespaces` list used to compile to `(project_id, env) IN (VALUES …)`: with
 * a single namespace Postgres flattened that to constant equalities and the
 * index's leading columns bound, but with two+ namespaces the VALUES became a
 * semi-join, the (project_id, env) prefix lost its equality constraints, and
 * the claim hot path fell back to sorting the whole backlog — a documented
 * config causing an order-of-magnitude plan regression with no warning. A
 * worker serving N namespaces now issues N candidate scans, each a pair of
 * constant equalities on `q` (`queue_claimable_idx` binds directly) with the
 * matching `r`-side equality made explicit. The `limit` is shared across the
 * scans in rotation order: each scan's window is `claimWindow(remaining)` for
 * the runs the namespaces earlier in that order have not claimed yet, and
 * scanning stops once the budget is met (the unscanned tail is reported via
 * `onScanSkipped`). Pinned to array order that sharing starves every
 * namespace behind a permanently busy one — P0-14 fixed it by making the scan
 * start rotatable: the caller advances `rotateFrom` once per claim, so each
 * served namespace leads the order within `namespaces.length` calls and gets
 * a non-zero share of the budget as long as the worker keeps polling.
 * Semantics are otherwise unchanged — the same (project_id, env) pairs are
 * served, the pairing can never leak a run across namespaces (each scan
 * constrains both columns to one exact pair), and every candidate still goes
 * through the same concurrency-limit + claim statements.
 *
 * Phase 2 — the ledger read, AFTER the transaction (p1-07):
 *   for each claimed run, read its run_steps snapshot OUTSIDE any transaction.
 *   The window's `FOR UPDATE SKIP LOCKED` rows are all released at COMMIT, so a
 *   fat ledger can no longer stall peer workers: the lock is held only for the
 *   fast claim, never for the materialization of thousands of steps. The read is
 *   safe outside the tx because the claim already holds the lease and the bumped
 *   fencing token — run_steps is append-only for a claimed run (stale-fencing
 *   writes are rejected), so there is no torn state to see. A read error here
 *   surfaces from claimRuns with the claims already committed: the runs hold
 *   valid leases and are recovered by the lease reaper exactly as after a
 *   worker crash (each spends one `recoveries`, never an `attempt`).
 *
 * When `maxSteps` is set, the snapshot reads `maxSteps + 1` rows so an overflow
 * is visible without a second count: the run is still claimed but marked
 * `stepsTruncated` (and its steps trimmed to `maxSteps`), which the executor
 * fails non-retryably — replaying a truncated ledger would silently skip steps.
 *
 * Returns claimed runs + step snapshots + the fencing token guarding each
 * claim's writes. Expired-lease recovery is the reaper's job alone — candidates
 * here stay `locked_by IS NULL`.
 *
 * The candidate SELECT carries every column the loop needs (todos/02-performance.md
 * PF4). It already had to `JOIN runs` for the task filter, so the run's execution
 * columns and the task's concurrency_limit ride along for free instead of costing
 * two round trips *per candidate* — a window of 10 used to mean 20+ statements for
 * a call that normally claims one run. Only `run_steps` stays per-run: it is needed
 * for the runs actually claimed, which is a small subset of the window — and, as of
 * p1-07, it runs after COMMIT so the window lock is never extended for it.
 *
 * Locking is unchanged by the join. `FOR UPDATE OF q` locks queue rows and only
 * queue rows — `runs` and `tasks` are read, never locked — so the scan still
 * takes canonical position 1 and nothing else, and the runs row is still first
 * locked by the claiming UPDATE below (position 2). Reading the runs columns in
 * the same statement is safe for the same reason it was safe one statement later:
 * every path that mutates a run takes that run's queue row FOR UPDATE first, so a
 * mutation racing us either holds the queue row (we SKIP LOCKED past it and never
 * see the row at all) or is not yet committed when our snapshot is taken — in
 * which case its pre-image has locked_by set (a claimed run being failed/retried)
 * and fails the candidate predicate. Fencing is untouched: fencing_token is still
 * read from the RETURNING of the same-tx UPDATE that bumps it, never from here.
 */
export async function claimRuns(pool: Pool, args: ClaimRunsArgs): Promise<ClaimedRun[]> {
  if (args.limit > MAX_CLAIM_LIMIT) {
    throw new KernelError(
      'bad_request',
      `limit must be at most ${MAX_CLAIM_LIMIT} — see MAX_CLAIM_LIMIT (a larger claim would lock a larger window FOR UPDATE)`,
    );
  }
  if (args.taskIds.length === 0 || args.limit <= 0) return [];
  assertNamespaces(args.namespaces);
  const logger: KernelLogger = args.logger ?? console;

  const codeVersions = args.codeVersions ?? [];
  const pinned = args.codeVersions !== undefined;
  if (pinned && codeVersions.length !== args.taskIds.length) {
    // Positional arrays: a length mismatch would silently pin some task to
    // another's version and quietly stop claiming its runs. Refuse instead —
    // the caller built both arrays from one list and cannot be off by one on
    // purpose.
    throw new KernelError(
      'bad_request',
      `codeVersions must be parallel to taskIds (${codeVersions.length} vs ${args.taskIds.length})`,
    );
  }

  const client = await pool.connect();
  try {
    // Hand-written tx, not withTx: phase 2 (readLedger) must run AFTER this tx
    // commits (p1-07) — withTx's callback IS the transaction, so it has no
    // post-commit phase to hang the ledger read on.
    await client.query('BEGIN');

    const pending: PendingClaim[] = [];

    const skipped = await scanCandidates(client, args, pinned, codeVersions, pending, logger);

    await client.query('COMMIT');

    // The observer runs AFTER the commit (it used to fire mid-tx, where a
    // throwing host callback rolled the whole claim back): it is documented
    // as purely observational, so its failure is contained to a warn and the
    // claims stand whatever it does.
    if (skipped.length > 0 && args.onScanSkipped) {
      try {
        args.onScanSkipped(skipped);
      } catch (err) {
        logger.warn(
          `[queue:claim] onScanSkipped observer threw — skipped-namespace report dropped: ${String(err)}`,
        );
      }
    }

    return readLedger(client, args, pending);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One (task, version) pair nobody online can currently claim. */
export interface StrandedGroup {
  taskId: string;
  codeVersion: string;
  /** Due, unclaimed runs in this group at scan time. */
  count: number;
}

/** Result of one stranded-run scan. */
export interface StrandedScan {
  /** Biggest groups first, capped — see STRANDED_GROUP_LIMIT. */
  groups: StrandedGroup[];
  /** More groups existed than the cap reports. The counts shown are still
   *  exact; the total across all groups is not. */
  truncated: boolean;
}

/**
 * How many groups one scan reports. Every group becomes a labelled metric
 * sample, so this is the cardinality bound on `better_trigger_stranded_runs`
 * as much as it is a query bound; the biggest groups come first, and the
 * caller is told when it truncated (see the orchestrator's stranded loop).
 */
const STRANDED_GROUP_LIMIT = 20;

/**
 * Runs that are due and unclaimed, and whose `code_version` no online worker
 * serves for that task — the failure mode version pinning creates.
 *
 * With `--pin-code-version` a claim skips runs whose ledger this build cannot
 * replay, which is the point; but a run whose version left the fleet for good
 * (the worker was replaced rather than restarted) then waits forever, and the
 * only outward symptom is a queue that never moves. This is what turns that
 * into a number and a log line.
 *
 * "Served" is read off the online workers' own `tasks` manifests, which carry
 * `{ id, codeVersion }` per task, intersected with the worker's `namespaces`
 * jsonb: a worker only serves a namespace it is configured for (C2). Rows
 * written by an older build hold bare id strings; those normalize to the
 * worker-level `code_version`, which is exactly what that build stamped its
 * tasks with.
 *
 * "Online" includes the heartbeat window (WORKER_OFFLINE_MS), the same reading
 * the cron served-check and the registration guard use: a row that is still
 * status='online' but stopped heartbeating must count as gone here too, or the
 * stranded scan and the other surfaces give opposite answers about the same
 * worker for up to one window (the offline marker flips the status only on its
 * own 30s tick).
 *
 * Meaningless when nothing pins (an unpinned worker claims these runs on its
 * next poll), so the loop that calls it is off unless pinning is on.
 */
export async function scanStrandedRuns(
  pool: Pool,
  namespaces: readonly Namespace[],
): Promise<StrandedScan> {
  assertNamespaces(namespaces);
  // $1 is the LIMIT and $2 the heartbeat window, both written literally in the
  // SQL; the namespace pairs are numbered after them (see namespacePredicate).
  const params: unknown[] = [STRANDED_GROUP_LIMIT + 1, String(WORKER_OFFLINE_MS)];
  const nsPredicate = namespacePredicate('r', namespaces, params);
  const res = await pool.query<{ task_id: string; code_version: string; n: string }>(
    `SELECT r.task_id, r.code_version, count(*)::text AS n
       FROM queue q
       JOIN runs r ON r.id = q.run_id
      WHERE q.locked_by IS NULL
        AND q.available_at <= now()
        AND r.code_version IS NOT NULL
        AND ${nsPredicate}
        AND NOT EXISTS (
          SELECT 1 FROM workers w
           CROSS JOIN LATERAL jsonb_array_elements(w.tasks) e
           CROSS JOIN LATERAL jsonb_array_elements(w.namespaces) n
           WHERE w.status = 'online'
             AND w.last_heartbeat_at > now() - ($2::text || ' milliseconds')::interval
             AND COALESCE(e->>'id', e #>> '{}') = r.task_id
             AND COALESCE(e->>'codeVersion', w.code_version) = r.code_version
             AND n->>'projectId' = r.project_id
             AND n->>'env' = r.env
        )
      GROUP BY 1, 2
      ORDER BY count(*) DESC, r.task_id ASC
      LIMIT $1`,
    // One row past the cap, so "exactly full" is distinguishable from "there
    // was more" without a second count query.
    params,
  );
  const rows = res.rows.map((r) => ({
    taskId: r.task_id,
    codeVersion: r.code_version,
    count: Number(r.n),
  }));
  return {
    groups: rows.slice(0, STRANDED_GROUP_LIMIT),
    truncated: rows.length > STRANDED_GROUP_LIMIT,
  };
}

export interface HeartbeatArgs {
  workerId: string;
  /** Namespaces this worker serves — the renewal and cancel checks re-scope on
   *  them (C2; redundant per-run since run ids are globally unique, but the
   *  isolation predicates are applied everywhere by design). */
  namespaces: readonly Namespace[];
  /** Runs currently executing on this worker (leases get renewed). */
  runIds: string[];
  /** Lease duration to extend to (lease_until = now() + leaseMs). */
  leaseMs: number;
}

export interface HeartbeatResult {
  /** Runs canceled server-side — the worker stops them (ctx.signal aborts). */
  cancelRunIds: string[];
  /**
   * Runs this worker asked to renew but no longer holds the claim on
   * (todos/01-correctness.md C2). Disjoint from cancelRunIds: a cancel is the
   * more specific answer for the same run and wins.
   */
  lostRunIds: string[];
}

/**
 * Renew leases for the given runs owned by this worker (heartbeat).
 * locked_at keeps its claim-time semantics and is not refreshed.
 * Returns the run ids that have been canceled (so the worker can stop them)
 * plus the ones whose claim is gone (so it can stop those too). Throws
 * KernelError('not_found') when the worker's own row is gone — the heartbeat
 * that used to ride that out as a silent 0-row UPDATE is exactly how a
 * pruned-while-online worker stayed invisible; the error is the re-register
 * (or alert) signal for the caller.
 *
 * `lostRunIds` costs nothing extra: the renewal is already scoped by
 * `locked_by = us`, so `RETURNING run_id` turns the statement the heartbeat
 * had to issue anyway into the answer to "which of these am I still the owner
 * of" — requested minus renewed is the loss set, same two round trips as before.
 *
 * It deliberately does NOT distinguish *why* a renewal missed. Both causes —
 * the lease was reaped and handed to another daemon, or the queue row is gone
 * because the run reached a terminal/waiting state through some other path —
 * mean the same thing to the caller: nothing this executor computes from here
 * on can legally be written (assertOwnedRunning checks queue.locked_by), so
 * carrying on is pure waste. The reaction is a local abort, never a kernel
 * write, so a false positive can cost at most an execution that was already
 * void. Telling the two apart would need a third query for no change in
 * behaviour.
 */
export async function heartbeat(
  pool: Pool,
  args: HeartbeatArgs,
): Promise<HeartbeatResult> {
  assertNamespaces(args.namespaces);
  // Extend leases for runs still owned by this worker; the rows that come back
  // are exactly the claims we still hold.
  let renewed: string[] = [];
  if (args.runIds.length > 0) {
    // $1 leaseMs / $2 workerId / $3 runIds are literal in the SQL; the
    // namespace pairs continue from $4 in the same array.
    const params: unknown[] = [String(args.leaseMs), args.workerId, args.runIds];
    const nsPredicate = namespacePredicate('queue', args.namespaces, params);
    const res = await pool.query<{ run_id: string }>(
      `UPDATE queue SET lease_until = now() + ($1::text || ' milliseconds')::interval
        WHERE locked_by = $2 AND run_id = ANY($3::text[]) AND ${nsPredicate}
        RETURNING run_id`,
      params,
    );
    renewed = res.rows.map((r) => r.run_id);
  }
  // A 0-row touch means the workers row is GONE — prune deleted an
  // offline-and-stale row while the process stayed alive (long partition,
  // missed offline-marker window). Silent success here let such a worker keep
  // claiming while being invisible to servedTaskIds / the stranded scan / the
  // offline marker / the dashboard, so the miss is now an error: the caller
  // must re-register (the row it heartbeats no longer exists). The unheld
  // leases simply lapse to the reaper, which is the correct outcome for a
  // worker with no row.
  const touched = await pool.query(
    `UPDATE workers SET last_heartbeat_at = now(), status = 'online' WHERE id = $1`,
    [args.workerId],
  );
  if (touched.rowCount === 0) {
    throw new KernelError(
      'not_found',
      `worker ${args.workerId} no longer has a workers row (pruned while online?) — re-register before heartbeating`,
    );
  }

  if (args.runIds.length === 0) return { cancelRunIds: [], lostRunIds: [] };
  // Any of the heartbeat's runs that are no longer 'running' → tell worker to drop.
  // $1 is the run id list; the namespace pairs continue from $2.
  const params: unknown[] = [args.runIds];
  const nsPredicate = namespacePredicate('runs', args.namespaces, params);
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM runs
      WHERE id = ANY($1::text[]) AND status = 'canceled' AND ${nsPredicate}`,
    params,
  );
  const cancelRunIds = res.rows.map((r) => r.id);

  const held = new Set(renewed);
  const canceled = new Set(cancelRunIds);
  const lostRunIds = args.runIds.filter((id) => !held.has(id) && !canceled.has(id));
  return { cancelRunIds, lostRunIds };
}

export interface ReleaseClaimsArgs {
  /** Only this worker's claims are released — never another worker's. */
  workerId: string;
  /** Namespaces this worker serves; the hand-back statements re-scope on them
   *  (C2). */
  namespaces: readonly Namespace[];
  /** Optional filter: release ONLY these run ids (e.g. one freshly-claimed run
   *  that must not execute because the worker is stopping). Absent → release all
   *  of this worker's claims. */
  runIds?: string[];
}

export interface ReleaseClaimsResult {
  /** Runs handed back, for the caller to log. Empty when nothing was held. */
  releasedRunIds: string[];
}

/**
 * Hand every claim this worker still holds back to the queue — the graceful
 * shutdown counterpart of the lease reaper (todos/01-correctness.md C3).
 *
 * A stopping daemon that just exits leaves its undrained runs with locked_by
 * set and a lease that is still valid, so nothing may touch them until the
 * lease expires (60s) and the reaper's next tick notices — and the reaper's
 * recovery path spends one of the run's `recoveries` (C4), which turns a clean
 * `docker compose restart` into a charge against the budget that exists for
 * machines dying. This releases them instead:
 *
 *   - Neither counter moves: `runs.attempt` (the user's code failing) and
 *     `runs.recoveries` (infrastructure taking a run away) are both left
 *     alone. A stop is a handover — nothing failed and nothing was recovered;
 *     the run picks up where its ledger left off on its next claim.
 *   - `runs.fencing_token` is NOT bumped either (only claimRuns ever bumps it),
 *     and it does not need to be: assertOwnedRunning also requires
 *     queue.locked_by to be this worker, so dropping the claim makes a late
 *     write from an executor that ignored the drain *illegal immediately*
 *     rather than legal until the reaper — releasing a claim can never widen
 *     the window in which stale writes are accepted. The next claim's token++
 *     invalidates them for good.
 *   - `runs.status` goes back to 'queued', exactly as failRun's retry branch
 *     and the reaper do. Not cosmetic: a run left 'running' would be counted
 *     against its own concurrency_key by claimRuns' limit check, and a task at
 *     concurrency_limit 1 could never reclaim it.
 *   - `available_at = now()` so the next worker picks it up on its next poll
 *     instead of after the lease.
 *
 * Idempotent: a second call matches no rows (concurrent shutdown paths, a
 * signal landing during a crash drain). Lock order is canonical — the queue
 * rows are locked first, each run's row second (see runs.ts header).
 *
 * With `runIds`, only those runs are released — the worker's other claims stay
 * untouched. Used to hand back a single run that was claimed but must never
 * execute (a claim that resolved after the worker started stopping): it is
 * claimable at once, costs neither an attempt nor a recovery, and the claim's
 * fencing-token bump is left alone — the next claim's token++ invalidates any
 * late write just as it does on the all-claims path.
 */
export async function releaseClaims(
  pool: Pool,
  args: ReleaseClaimsArgs,
): Promise<ReleaseClaimsResult> {
  assertNamespaces(args.namespaces);
  const client = await pool.connect();
  try {
    // Hand-written tx, not withTx: this is the one scan that deliberately
    // BLOCKS on queue rows (no SKIP LOCKED — see above), and its N locks must
    // live until the release COMMITs. withTx would wrap this identically; the
    // explicit BEGIN/COMMIT keeps that held-lock span visible beside the scan.
    await client.query('BEGIN');

    // Canonical lock position 1. Deliberately NOT `SKIP LOCKED`: a row of ours
    // held by another transaction is one being reaped or completed right now,
    // and waiting for it costs a moment on a path that has nothing else to do.
    // ORDER BY keeps the acquisition order deterministic. Scoped to this
    // worker's namespaces (C2); each row's project_id/env ride along so the
    // statements below re-scope per run.
    // $1 is the worker id, literal in the SQL; the namespace pairs continue
    // from $2 in the same array (see namespacePredicate). A runIds filter (when
    // present) is the last parameter — a single run claimed but never to be
    // executed is released by id while this worker's other claims stay put.
    const params: unknown[] = [args.workerId];
    const nsPredicate = namespacePredicate('queue', args.namespaces, params);
    const runIdPredicate =
      args.runIds !== undefined ? ` AND run_id = ANY($${params.length + 1}::text[])` : '';
    if (args.runIds !== undefined) params.push(args.runIds);
    const held = await client.query<{ run_id: string; project_id: string; env: string }>(
      `SELECT run_id, project_id, env FROM queue
        WHERE locked_by = $1 AND ${nsPredicate}${runIdPredicate}
        ORDER BY run_id FOR UPDATE`,
      params,
    );
    const runs = held.rows;
    if (runs.length === 0) {
      await client.query('COMMIT');
      return { releasedRunIds: [] };
    }

    // Canonical lock position 2, one run at a time. `status = 'running'` scopes
    // it to runs this worker was actually executing; anything else (a run that
    // reached a terminal state between the two statements) keeps its own state.
    for (const r of runs) {
      await client.query(
        `UPDATE runs SET status = 'queued', updated_at = now()
          WHERE id = $1 AND status = 'running' AND project_id = $2 AND env = $3`,
        [r.run_id, r.project_id, r.env],
      );
    }

    // The release itself. `locked_by = $1` is re-checked so this can only ever
    // clear this worker's own claims, whatever else raced in between; each row
    // is re-scoped by its (run_id, project_id, env) triple.
    const start = 2;
    const triples = runs
      .map((_, i) => `($${start + i * 3}::text, $${start + i * 3 + 1}::text, $${start + i * 3 + 2}::text)`)
      .join(', ');
    const released = await client.query<{ run_id: string }>(
      `UPDATE queue
          SET locked_by = NULL, locked_at = NULL, lease_until = NULL, available_at = now()
        WHERE locked_by = $1 AND (run_id, project_id, env) IN (VALUES ${triples})
        RETURNING run_id`,
      [args.workerId, ...runs.flatMap((r) => [r.run_id, r.project_id, r.env])],
    );

    // Handed-back runs are claimable at once: wake the other daemons' claim
    // loops inside the tx (delivered at COMMIT) so a shutdown does not park
    // work behind their idle backoff. Harmless when nothing was released.
    if (released.rows.length > 0) await notifyWork(client);

    await client.query('COMMIT');
    return { releasedRunIds: released.rows.map((r) => r.run_id) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
