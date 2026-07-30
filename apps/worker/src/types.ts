/* =============================================================================
   @better-trigger/worker — REST types.
   Trigger API + Dashboard API response/request shapes (docs/backend-contract.md
   §4–5). All endpoints live under /api/v1 and speak camelCase JSON.
   Dates travel as ISO-8601 strings.

   Every response shape here is an alias of a read model in
   @better-trigger/core — the wire format has exactly one definition, and
   apps/web aliases the same core types, so a change to any of them cannot
   drift past the type checker on either end.
   ============================================================================= */
import type {
  CreatedRun,
  LogRecord,
  RunDetailResult,
  RunRecord,
  RunStepRecord,
  RunsResponse as RunsResponseModel,
  RunSummary as RunSummaryModel,
  SchedulesResponse as SchedulesResponseModel,
  ScheduleSummary as ScheduleSummaryModel,
  TasksResponse as TasksResponseModel,
  TaskSummary as TaskSummaryModel,
  TriggerItem,
  TriggerOptions,
  WaitRecord,
  WorkersResponse as WorkersResponseModel,
  WorkerSummary as WorkerSummaryModel,
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
    /**
     * Present on a production `internal_error`, where the message is generic:
     * the same id tags the server log line carrying the real error.
     */
    requestId?: string;
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
/** `idempotent: true` → idempotencyKey matched an existing run. */
export type TriggerResponse = CreatedRun;

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

/** pg Pool counters as of a deep health probe — numbers only, no host. */
export interface HealthPoolStats {
  /** Clients the pool currently holds open. */
  total: number;
  /** Of those, the ones sitting idle. */
  idle: number;
  /** Callers queued waiting for a client (> 0 means the pool is saturated). */
  waiting: number;
}

/**
 * GET /api/v1/health (liveness) · GET /api/v1/health?deep=1 (readiness).
 * `db` and `pool` are present on the deep probe only, where `ok: false` is
 * answered with 503.
 */
export interface HealthResponse {
  ok: boolean;
  version: string;
  db?: { ok: true } | { ok: false; error: 'timeout' | 'query_failed' };
  pool?: HealthPoolStats;
}

/** GET /api/v1/tasks */
export type TaskSummary = TaskSummaryModel;
export type TasksResponse = TasksResponseModel;

/** GET /api/v1/runs */
export type RunSummary = RunSummaryModel;
export type RunsResponse = RunsResponseModel;

/** GET /api/v1/runs/:id */
export type RunDetail = RunRecord;
export type RunStepRow = RunStepRecord;
export type WaitRow = WaitRecord;
export type LogRow = LogRecord;
export type RunDetailResponse = RunDetailResult;

/** POST /api/v1/runs/:id/retry */
export interface RetryRunResponse {
  runId: string;
}

/** GET /api/v1/schedules */
export type ScheduleSummary = ScheduleSummaryModel;
export type SchedulesResponse = SchedulesResponseModel;
/** PATCH /api/v1/schedules/:id */
export interface UpdateScheduleRequest {
  enabled: boolean;
}

/** GET /api/v1/workers */
export type WorkerSummary = WorkerSummaryModel;
export type WorkersResponse = WorkersResponseModel;
