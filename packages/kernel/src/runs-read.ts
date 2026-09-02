// Run reads: getRunRecord / getRunDetail / waitForResult.

import type { Pool, PoolClient } from 'pg';
import {
  assertNamespace,
  KernelError,
  type LogLevel,
  type LogRecord,
  type Namespace,
  type RunDetailResult,
  type RunRecord,
  type RunStatus,
  type RunStepRecord,
  type SerializedError,
  type StepKind,
  type StepStatus,
  type TriggerType,
  type WaitForResultOptions,
  type WaitKind,
  type WaitRecord,
  type WaitResult,
} from '@better-trigger/core';
import { TERMINAL_STATUSES } from './queue';
import { withTx } from './runs-internal';

/* Run-detail read caps (PF3): steps/waits and the logs page are bounded so a
   very long agent run cannot produce an unbounded detail JSON. Logs are paged
   through the id-based `logsBefore` cursor; steps/waits are simply capped at
   the newest rows with a truncated flag (full pagination for them is future
   work, todos/02-performance.md PF3). */
const DEFAULT_DETAIL_LOGS_LIMIT = 200;
const DEFAULT_DETAIL_STEPS_LIMIT = 500;
const DEFAULT_DETAIL_WAITS_LIMIT = 500;
const MAX_DETAIL_PAGE = 5000;

/* ---------------------------------------------------------------------------
 * Run reads: getRun / getRunDetail / waitForResult
 * ------------------------------------------------------------------------- */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const durationMs = (started: Date | null, finished: Date | null): number | null =>
  started && finished ? finished.getTime() - started.getTime() : null;

export async function getRunRecord(
  db: Pool | PoolClient,
  runId: string,
  namespace: Namespace,
): Promise<RunRecord> {
  assertNamespace(namespace);
  const runRes = await db.query<{
    id: string;
    task_id: string;
    status: string;
    trigger_type: string;
    code_version: string | null;
    project_id: string;
    env: string;
    attempt: number;
    max_attempts: number;
    payload: unknown;
    output: unknown;
    error: unknown;
    parent_run_id: string | null;
    idempotency_key: string | null;
    queued_at: Date | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
  }>(
    `SELECT id, task_id, status, trigger_type, code_version, project_id, env,
            attempt, max_attempts, payload, output, error, parent_run_id,
            idempotency_key, queued_at, created_at, started_at, finished_at
       FROM runs WHERE id = $1 AND project_id = $2 AND env = $3`,
    [runId, namespace.projectId, namespace.env],
  );
  const r = runRes.rows[0];
  if (!r) throw new KernelError('not_found', `run ${runId} not found`);

  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status as RunStatus,
    trigger: r.trigger_type as TriggerType,
    codeVersion: r.code_version,
    projectId: r.project_id,
    env: r.env,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    durationMs: durationMs(r.started_at, r.finished_at),
    createdAt: r.created_at.toISOString(),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    payload: r.payload,
    output: r.output,
    error: (r.error as SerializedError | null) ?? null,
    parentRunId: r.parent_run_id,
    idempotencyKey: r.idempotency_key,
    queuedAt: iso(r.queued_at),
  };
}

/** Options for getRunDetail (PF3). All limits optional; defaults keep a single
 *  detail page bounded (~200 log lines, 500 steps / 500 waits at most). */
export interface RunDetailOptions {
  /** Page size for logs — the newest N lines, ascending in the response.
   *  Default 200; capped at MAX_DETAIL_PAGE. */
  logsLimit?: number;
  /** Return only logs with id < logsBefore — the page strictly older than the
   *  one whose oldest line carries this id (the response's logsNextCursor). */
  logsBefore?: number;
  /** Cap on steps rows (newest kept). Default 500; capped at MAX_DETAIL_PAGE. */
  stepsLimit?: number;
  /** Cap on waits rows (newest kept). Default 500; capped at MAX_DETAIL_PAGE. */
  waitsLimit?: number;
}

/** Clamp an optional count to [1, max] with a fallback — a page size of 0 or a
 *  negative one is a caller bug, refused before it reaches pg as `LIMIT 0`. */
function detailLimit(name: string, v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new KernelError('bad_request', `${name} must be a positive integer`);
  }
  return Math.min(v, MAX_DETAIL_PAGE);
}

/**
 * Run + steps + waits + logs from ONE snapshot. All four reads run in a single
 * REPEATABLE READ transaction (withTx's isolation option — a dedicated
 * connection from the pool, released on every path), so a run changing
 * mid-read cannot produce a detail whose parts disagree: the run status,
 * ledger and logs all reflect the same point in time (PF3,
 * todos/02-performance.md).
 *
 * Logs come back as the NEWEST page (default 200 lines) in ascending id order
 * (chronological display); `logsNextCursor` carries the oldest line's id when
 * older logs exist, and passing it back as `logsBefore` fetches the previous
 * page — so a 1200-line run shows its last error by default and pages back to
 * the beginning. steps/waits are capped at the newest rows with a truncated
 * flag.
 */
export async function getRunDetail(
  pool: Pool,
  runId: string,
  namespace: Namespace,
  opts: RunDetailOptions = {},
): Promise<RunDetailResult> {
  assertNamespace(namespace);
  const logsLimit = detailLimit('logsLimit', opts.logsLimit, DEFAULT_DETAIL_LOGS_LIMIT);
  const stepsLimit = detailLimit('stepsLimit', opts.stepsLimit, DEFAULT_DETAIL_STEPS_LIMIT);
  const waitsLimit = detailLimit('waitsLimit', opts.waitsLimit, DEFAULT_DETAIL_WAITS_LIMIT);
  const logsBefore = opts.logsBefore;
  if (logsBefore !== undefined && (!Number.isSafeInteger(logsBefore) || logsBefore < 1)) {
    throw new KernelError('bad_request', 'logsBefore must be a positive integer');
  }

  // REPEATABLE READ so the four reads share one snapshot — the reason withTx
  // gained its isolation option (the one hand-written BEGIN it replaced).
  return withTx(
    pool,
    (client) =>
      readRunDetail(client, runId, namespace, {
        logsLimit,
        logsBefore,
        stepsLimit,
        waitsLimit,
      }),
    { isolation: 'repeatable read' },
  );
}

/** The four reads of getRunDetail, executed on an already-open tx client. */
async function readRunDetail(
  client: PoolClient,
  runId: string,
  namespace: Namespace,
  opts: Required<Pick<RunDetailOptions, 'logsLimit' | 'stepsLimit' | 'waitsLimit'>> & {
    logsBefore?: number;
  },
): Promise<RunDetailResult> {
  const run = await getRunRecord(client, runId, namespace);

  const stepsRes = await client.query<{
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
       FROM run_steps WHERE run_id = $1 AND project_id = $2 AND env = $3
      ORDER BY seq DESC LIMIT $4`,
    [runId, namespace.projectId, namespace.env, opts.stepsLimit + 1],
  );
  // Newest rows kept, oldest cut — the extra probe row (limit+1) is the proof
  // that older ones exist, and doubles as the truncation flag.
  const stepsTruncated = stepsRes.rows.length > opts.stepsLimit;
  const keptSteps = stepsTruncated ? stepsRes.rows.slice(0, opts.stepsLimit) : stepsRes.rows;
  const steps: RunStepRecord[] = keptSteps.reverse().map((s) => ({
    seq: s.seq,
    kind: s.kind as StepKind,
    label: s.label,
    status: s.status as StepStatus,
    output: s.output,
    error: (s.error as SerializedError | null) ?? null,
    attempt: s.attempt,
    startedAt: iso(s.started_at),
    finishedAt: iso(s.finished_at),
  }));

  const waitsRes = await client.query<{
    id: number;
    step_seq: number;
    kind: string;
    resume_at: Date | null;
    child_run_id: string | null;
    status: string;
  }>(
    `SELECT id, step_seq, kind, resume_at, child_run_id, status
       FROM waits WHERE run_id = $1 AND project_id = $2 AND env = $3
      ORDER BY id DESC LIMIT $4`,
    [runId, namespace.projectId, namespace.env, opts.waitsLimit + 1],
  );
  const waitsTruncated = waitsRes.rows.length > opts.waitsLimit;
  const keptWaits = waitsTruncated ? waitsRes.rows.slice(0, opts.waitsLimit) : waitsRes.rows;
  const waits: WaitRecord[] = keptWaits.reverse().map((w) => ({
    id: Number(w.id),
    stepSeq: w.step_seq,
    kind: w.kind as WaitKind,
    resumeAt: iso(w.resume_at),
    childRunId: w.child_run_id,
    status: w.status as WaitRecord['status'],
  }));

  // Newest page, id-descending in SQL, reversed in memory for chronological
  // display; `id < $n` walks back through older pages via the cursor.
  const logsSql = opts.logsBefore === undefined
    ? `SELECT id, step_seq, level, message, data, ts
         FROM logs WHERE run_id = $1 AND project_id = $2 AND env = $3
        ORDER BY id DESC LIMIT $4`
    : `SELECT id, step_seq, level, message, data, ts
         FROM logs WHERE run_id = $1 AND project_id = $2 AND env = $3 AND id < $4
        ORDER BY id DESC LIMIT $5`;
  const logsParams = opts.logsBefore === undefined
    ? [runId, namespace.projectId, namespace.env, opts.logsLimit + 1]
    : [runId, namespace.projectId, namespace.env, opts.logsBefore, opts.logsLimit + 1];
  const logsRes = await client.query<{
    id: number;
    step_seq: number | null;
    level: string;
    message: string;
    data: unknown;
    ts: Date;
  }>(logsSql, logsParams);
  const logsTruncated = logsRes.rows.length > opts.logsLimit;
  const keptLogs = logsTruncated ? logsRes.rows.slice(0, opts.logsLimit) : logsRes.rows;
  const logs: LogRecord[] = keptLogs.reverse().map((l) => ({
    id: Number(l.id),
    stepSeq: l.step_seq,
    level: l.level as LogLevel,
    message: l.message,
    data: l.data,
    ts: l.ts.toISOString(),
  }));
  const oldestId = logs.length > 0 ? logs[0]!.id : null;
  const logsNextCursor = logsTruncated && oldestId !== null ? oldestId : null;

  return { run, steps, stepsTruncated, waits, waitsTruncated, logs, logsNextCursor };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a run until it reaches a terminal state. On timeout the latest
 * (non-terminal) status is returned without output/error.
 */
export async function waitForResult(
  pool: Pool,
  runId: string,
  namespace: Namespace,
  opts: WaitForResultOptions = {},
): Promise<WaitResult> {
  assertNamespace(namespace);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 250;
  // Same family as detailLimit/logsBefore: the HTTP route clamps pollMs to
  // [50, 5000], but this function is also the embedded-host path and a public
  // Kernel method. A 0/negative/NaN value turns sleep(pollMs) into a
  // zero-delay timer and the whole timeout window into a tight SELECT loop
  // against the database — a caller bug, refused before it can burn pool
  // connections. Infinity is rejected for the same reason (no sleep at all).
  if (!Number.isFinite(pollMs) || pollMs < 1) {
    throw new KernelError('bad_request', `pollMs must be a finite number >= 1, got ${pollMs}`);
  }
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const res = await pool.query<{ status: string; output: unknown; error: unknown }>(
      `SELECT status, output, error FROM runs
        WHERE id = $1 AND project_id = $2 AND env = $3`,
      [runId, namespace.projectId, namespace.env],
    );
    const row = res.rows[0];
    if (!row) throw new KernelError('not_found', `run ${runId} not found`);
    const status = row.status as RunStatus;
    if (TERMINAL_STATUSES.includes(status)) {
      return {
        status,
        output: row.output ?? undefined,
        error: (row.error as SerializedError | null) ?? undefined,
      };
    }
    if (Date.now() + pollMs >= deadline) return { status };
    await sleep(pollMs);
  }
}
