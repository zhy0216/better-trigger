/* =============================================================================
   @better-trigger/core — HTTP protocol types.
   Worker ↔ Server protocol + Trigger API + Dashboard API (docs/backend-contract.md §4–5).
   All endpoints live under /api/v1 and speak camelCase JSON.
   Dates travel as ISO-8601 strings.
   ============================================================================= */
import type {
  LogLevel,
  RetryPolicy,
  RunStatus,
  SerializedError,
  StepKind,
  StepSnapshot,
  StepStatus,
  TaskManifest,
  TriggerOptions,
  TriggerType,
  WaitKind,
} from './types';

/* ---------------------------------------------------------------------------
 * Shared envelope
 * ------------------------------------------------------------------------- */

export interface OkResponse {
  ok: true;
}

/** Error body returned with a non-2xx status. */
export interface ApiErrorBody {
  error: {
    /** Stable machine-readable code, e.g. 'run_not_running', 'task_not_found'. */
    code: string;
    message: string;
  };
}

/* ---------------------------------------------------------------------------
 * Worker protocol
 * ------------------------------------------------------------------------- */

/** POST /api/v1/workers/register */
export interface RegisterWorkerRequest {
  name?: string;
  codeVersion: string;
  runtime: 'self-host';
  concurrency: number;
  tasks: TaskManifest[];
}
export interface RegisterWorkerResponse {
  workerId: string;
  heartbeatIntervalMs: number;
  visibilityTimeoutMs: number;
}

/** POST /api/v1/workers/:id/heartbeat */
export interface HeartbeatRequest {
  /** Runs currently executing on this worker (locks get extended). */
  runIds: string[];
}
export interface HeartbeatResponse {
  ok: true;
  /** Runs the server wants the worker to stop executing (canceled). */
  cancelRunIds: string[];
}

/** GET /api/v1/dequeue?workerId=&timeoutMs= (long-poll) */
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
export interface DequeueResponse {
  run: DequeuedRun | null;
}

/** POST /api/v1/runs/:id/steps */
export interface ReportStepRequest {
  seq: number;
  kind: StepKind;
  label?: string;
  status: StepStatus;
  output?: unknown;
  error?: SerializedError;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  workerId: string;
}

/** POST /api/v1/runs/:id/suspend */
export interface SuspendRequest {
  seq: number;
  label?: string;
  kind: 'duration' | 'until';
  resumeAt: string;
  workerId: string;
}
export interface SuspendResponse {
  ok: true;
  /**
   * true → resumeAt was already in the past; the server recorded the wait as
   * completed and the worker should continue executing WITHOUT suspending.
   */
  resumed: boolean;
}

/** POST /api/v1/runs/:id/wait-for-run (triggerAndWait) */
export interface WaitForRunRequest {
  seq: number;
  label?: string;
  taskId: string;
  payload: unknown;
  options?: TriggerOptions;
  workerId: string;
}
export interface WaitForRunResponse {
  childRunId: string;
}

export interface TriggerItem {
  taskId: string;
  payload: unknown;
  options?: TriggerOptions;
}

/** POST /api/v1/runs/:id/batch-trigger (durable batchTrigger step) */
export interface BatchTriggerStepRequest {
  seq: number;
  label?: string;
  items: TriggerItem[];
  workerId: string;
}
export interface BatchTriggerStepResponse {
  runIds: string[];
}

/** POST /api/v1/runs/:id/complete */
export interface CompleteRunRequest {
  output: unknown;
  workerId: string;
}

/** POST /api/v1/runs/:id/fail */
export interface FailRunRequest {
  error: SerializedError;
  /** Seq of the step whose failure caused this, if any. */
  stepSeq?: number;
  /** Effective retry policy for this failure (step-level ?? task-level ?? default). */
  retry?: RetryPolicy;
  /** true → AbortError: fail immediately, no retry. */
  abort?: boolean;
  workerId: string;
}
export interface FailRunResponse {
  ok: true;
  willRetry: boolean;
  nextAttemptAt?: string;
}

/** POST /api/v1/runs/:id/logs */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  data?: unknown;
  stepSeq?: number;
}
export interface ReportLogsRequest {
  logs: LogEntry[];
}

/* ---------------------------------------------------------------------------
 * Trigger API (app code / external systems / dashboard)
 * ------------------------------------------------------------------------- */

/** POST /api/v1/trigger */
export interface TriggerRequest {
  taskId: string;
  payload: unknown;
  options?: TriggerOptions;
}
export interface TriggerResponse {
  runId: string;
  /** true → idempotencyKey matched an existing run. */
  idempotent: boolean;
}

/** POST /api/v1/batch-trigger */
export interface BatchTriggerRequest {
  items: TriggerItem[];
}
export interface BatchTriggerResponse {
  runIds: string[];
}

/* ---------------------------------------------------------------------------
 * Dashboard API
 * ------------------------------------------------------------------------- */

/** GET /api/v1/health */
export interface HealthResponse {
  ok: true;
  version: string;
}

/** GET /api/v1/tasks */
export interface TaskSummary {
  id: string;
  name: string;
  filePath: string | null;
  triggerSource: 'api' | 'schedule';
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

/** GET /api/v1/runs */
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
  nextCursor: string | null;
}

/** GET /api/v1/runs/:id */
export interface RunDetail extends RunSummary {
  payload: unknown;
  output: unknown;
  error: SerializedError | null;
  parentRunId: string | null;
  idempotencyKey: string | null;
  maxAttempts: number;
  queuedAt: string | null;
}
export interface RunStepRow {
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
export interface WaitRow {
  id: number;
  stepSeq: number;
  kind: WaitKind;
  resumeAt: string | null;
  childRunId: string | null;
  status: 'pending' | 'completed' | 'canceled';
}
export interface LogRow {
  id: number;
  stepSeq: number | null;
  level: LogLevel;
  message: string;
  data: unknown;
  ts: string;
}
export interface RunDetailResponse {
  run: RunDetail;
  steps: RunStepRow[];
  waits: WaitRow[];
  logs: LogRow[];
}

/** POST /api/v1/runs/:id/retry */
export interface RetryRunResponse {
  runId: string;
}

/** GET /api/v1/schedules */
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
/** PATCH /api/v1/schedules/:id */
export interface UpdateScheduleRequest {
  enabled: boolean;
}

/** GET /api/v1/workers */
export interface WorkerSummary {
  id: string;
  name: string | null;
  codeVersion: string;
  runtime: string;
  tasks: string[];
  concurrency: number;
  status: 'online' | 'offline';
  startedAt: string;
  lastHeartbeatAt: string;
}
export interface WorkersResponse {
  workers: WorkerSummary[];
}
