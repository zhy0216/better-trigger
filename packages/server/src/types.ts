/* =============================================================================
   @better-trigger/server — dashboard REST types.
   Trigger API + Dashboard API response/request shapes (docs/backend-contract.md
   §4–5). All endpoints live under /api/v1 and speak camelCase JSON.
   Dates travel as ISO-8601 strings. apps/web mirrors these shapes locally.
   ============================================================================= */
import type {
  LogLevel,
  RunStatus,
  SerializedError,
  StepKind,
  StepStatus,
  TriggerItem,
  TriggerOptions,
  TriggerType,
  WaitKind,
} from '@better-trigger/core';

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
