/* =============================================================================
   @better-trigger/core — shared domain types.
   These are the authoritative definitions referenced by docs/backend-contract.md.
   ============================================================================= */

/** Run lifecycle states (server-side). */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'canceled';

/** What kind of memoized step a run_steps row records. */
export type StepKind =
  | 'step'
  | 'wait'
  | 'trigger-and-wait'
  | 'batch-trigger'
  | 'now'
  | 'random'
  | 'uuid';

/** Terminal state of a memoized step row. A 'failed' row is re-executed on replay. */
export type StepStatus = 'completed' | 'failed';

/**
 * How strictly replay checks that a cached step row belongs to the call site
 * that reached its seq.
 *   'lenient' (default) — kind/label mismatch logs a warning, cache still used.
 *   'strict'            — mismatch fails the run with a non-retryable
 *                         AbortError instead of feeding a foreign row to the
 *                         call site. Recommended for tasks with long waits,
 *                         where an in-flight ledger can outlive several deploys.
 */
export type ReplayMode = 'lenient' | 'strict';

/** What a suspended run is waiting on. */
export type WaitKind = 'duration' | 'until' | 'run';

/** How a run was created. */
export type TriggerType = 'api' | 'schedule' | 'subtask' | 'retry' | 'dashboard';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Exponential backoff retry policy. All fields optional; merged over DEFAULT_RETRY. */
export interface RetryPolicy {
  /** Total attempts including the first one. 1 = no retries. */
  maxAttempts?: number;
  /** Base delay in ms for the first retry. */
  baseMs?: number;
  /** Multiplier applied per attempt. */
  factor?: number;
  /** Upper bound for a single retry delay in ms. */
  maxMs?: number;
}

export const DEFAULT_RETRY: Required<RetryPolicy> = {
  maxAttempts: 3,
  baseMs: 1_000,
  factor: 2,
  maxMs: 300_000,
};

/** JSON-serializable error shape stored in runs.error / run_steps.error. */
export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
}

export interface CronConfig {
  /** Standard 5-field cron pattern, e.g. "0 9 * * *". */
  pattern: string;
  /** IANA timezone, e.g. "Asia/Shanghai". Defaults to server timezone. */
  timezone?: string;
}

/** Task definition metadata a worker reports on register. */
export interface TaskManifest {
  id: string;
  name?: string;
  filePath?: string;
  cron?: CronConfig;
  retry?: RetryPolicy;
  concurrencyLimit?: number;
  description?: string;
  /**
   * This task's own code version — the value stamped on every run created for
   * it (tasks.latest_code_version → runs.code_version), and what a version-
   * pinned claim matches against.
   *
   * Per *task*, not per deploy: the worker's own `code_version` identifies the
   * process ("which deploy is this"), but pinning a run to that would mean
   * editing one task freezes the in-flight runs of every other task in the
   * same file — and if that worker goes away, none of them can be claimed.
   * Absent (a worker built before this field existed) ⇒ the kernel falls back
   * to the worker-level version, i.e. the old whole-deploy behaviour.
   */
  codeVersion?: string;
}

/** Options accepted by trigger / batchTrigger / triggerAndWait. */
export interface TriggerOptions {
  /** Delay before the run becomes available: ms number or duration string ("10m"). */
  delay?: string | number;
  /** Unique per task; re-triggering with the same key returns the existing run. */
  idempotencyKey?: string;
  /** Higher-priority runs are claimed first. Default 0. */
  priority?: number;
  /** Concurrency grouping key. Defaults to the task id when the task has a limit. */
  concurrencyKey?: string;
  /** Environment scope. Defaults to the server-side default ('prod'). */
  env?: string;
}

/** Result of triggerAndWait — never throws for child failure; check `ok`. */
export interface TaskRunResult<TOutput = unknown> {
  /** Child run id. */
  id: string;
  ok: boolean;
  output?: TOutput;
  error?: SerializedError;
}

/** Memoized step snapshot shipped to workers on claim for replay. */
export interface StepSnapshot {
  seq: number;
  kind: StepKind;
  label: string | null;
  status: StepStatus;
  output?: unknown;
  error?: SerializedError;
  /**
   * Replay fingerprint (C1) recorded when the row was written: a stable hash of
   * the primitive kind, label, persistable inputs and the run's code version.
   * NULL for rows written before fingerprints existed — the executor treats
   * those leniently (warn + use the row) since they cannot be drift-checked.
   */
  fingerprint?: string | null;
}

/** Returned by trigger / batchTrigger. */
export interface RunHandle {
  id: string;
}

/** One trigger request item (trigger / batchTrigger / durable batch step). */
export interface TriggerItem {
  taskId: string;
  payload: unknown;
  options?: TriggerOptions;
}

/** A run handed to a worker for execution. */
export interface DequeuedRun {
  id: string;
  taskId: string;
  payload: unknown;
  attempt: number;
  maxAttempts: number;
  codeVersion: string | null;
  env: string;
  /** Memoized completed/failed steps for replay. */
  steps: StepSnapshot[];
}

/** A claimed run: the fencing token is the claim's write credential. */
export interface ClaimedRun extends DequeuedRun {
  fencingToken: number;
}

/** One structured log line reported by a worker. */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  data?: unknown;
  stepSeq?: number;
}

/* ---------------------------------------------------------------------------
 * Read models
 *
 * The shapes the worker returns from its read endpoints. They are declared
 * here (not next to the SQL that builds them) because both sides of the wire
 * need them: the kernel produces them, the SDK parses them out of JSON.
 * Dates are ISO-8601 strings, keys are camelCase — the JSON is these types.
 * ------------------------------------------------------------------------- */

/** Result of trigger(): the run id, plus whether an idempotency key hit. */
export interface CreatedRun {
  runId: string;
  idempotent: boolean;
}

/** Full run record (camelCase, dates as ISO-8601 strings). */
export interface RunRecord {
  id: string;
  taskId: string;
  status: RunStatus;
  trigger: TriggerType;
  codeVersion: string | null;
  env: string;
  attempt: number;
  maxAttempts: number;
  /** finished − started for terminal runs; null while queued/running/waiting. */
  durationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  payload: unknown;
  output: unknown;
  error: SerializedError | null;
  parentRunId: string | null;
  idempotencyKey: string | null;
  queuedAt: string | null;
}

export interface RunStepRecord {
  seq: number;
  kind: StepKind;
  label: string | null;
  status: StepStatus;
  output: unknown;
  error: SerializedError | null;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WaitRecord {
  id: number;
  stepSeq: number;
  kind: WaitKind;
  resumeAt: string | null;
  childRunId: string | null;
  status: 'pending' | 'completed' | 'canceled';
}

export interface LogRecord {
  id: number;
  stepSeq: number | null;
  level: LogLevel;
  message: string;
  data: unknown;
  ts: string;
}

/** Run + its full ledger (logs capped at 1000). */
export interface RunDetailResult {
  run: RunRecord;
  steps: RunStepRecord[];
  waits: WaitRecord[];
  logs: LogRecord[];
}

/* ---------------------------------------------------------------------------
 * Dashboard read models
 *
 * List/summary projections behind the dashboard endpoints (backend-contract §5).
 * They live here for the same reason as the run ledger above: the worker builds
 * the JSON from them and apps/web parses it back, so one declaration keeps both
 * ends of the wire honest.
 * ------------------------------------------------------------------------- */

/** How a task gets its runs — derived from the manifest (cron present or not). */
export type TriggerSource = 'api' | 'schedule';

/** Whether a worker's heartbeat is still current. */
export type WorkerStatus = 'online' | 'offline';

/** GET /tasks */
export interface TaskSummary {
  id: string;
  name: string;
  filePath: string | null;
  triggerSource: TriggerSource;
  cronPattern: string | null;
  runs24h: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** 0–100; null when the task has no finished runs. */
  successRate: number | null;
  /** 12 buckets × 2h of run counts over the last 24h, oldest first. */
  trend: number[];
  lastRunAt: string | null;
}
export interface TasksResponse {
  tasks: TaskSummary[];
}

/** GET /runs — the run row without payload/output/error (see RunRecord). */
export interface RunSummary {
  id: string;
  taskId: string;
  status: RunStatus;
  trigger: TriggerType;
  codeVersion: string | null;
  env: string;
  attempt: number;
  /** finished − started for terminal runs; null while queued/running/waiting. */
  durationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface RunsResponse {
  runs: RunSummary[];
  /** "<createdAt ISO>|<id>" of the last row; null on the final page. */
  nextCursor: string | null;
}

/** GET /schedules */
export interface ScheduleSummary {
  id: string;
  taskId: string;
  cronPattern: string;
  cronTz: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
}
export interface SchedulesResponse {
  schedules: ScheduleSummary[];
}

/** GET /workers */
export interface WorkerSummary {
  id: string;
  name: string | null;
  codeVersion: string;
  runtime: string;
  tasks: string[];
  concurrency: number;
  status: WorkerStatus;
  startedAt: string;
  lastHeartbeatAt: string;
}
export interface WorkersResponse {
  workers: WorkerSummary[];
}

export interface WaitForResultOptions {
  /** Give up after this long (default 30s). */
  timeoutMs?: number;
  /** Poll interval (default 250ms). */
  pollMs?: number;
}

/** Terminal outcome of a run — or its latest non-terminal status on timeout. */
export interface WaitResult {
  status: RunStatus;
  output?: unknown;
  error?: SerializedError;
}
