/* =============================================================================
   Better Trigger — dashboard HTTP client.
   Thin fetch wrapper over the server's /api/v1 surface (backend-contract §5).
   Response shapes are hand-written interfaces mirroring the server JSON
   (camelCase, ISO date strings) — deliberately NOT importing @better-trigger/core
   so the web app stays a self-contained vite build with zero node deps.
   ============================================================================= */

export const API_BASE_URL: string =
  (import.meta.env.VITE_BT_API_URL as string | undefined) ?? 'http://localhost:4848';

/** Set when VITE_BT_API_URL is explicitly configured; mock-only otherwise. */
export const API_CONFIGURED: boolean =
  typeof import.meta.env.VITE_BT_API_URL === 'string' && import.meta.env.VITE_BT_API_URL.length > 0;

const PREFIX = '/api/v1';

export class ApiError extends Error {
  status: number;
  /** machine-readable code from the server error envelope, when present. */
  code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = opts;
  const res = await fetch(API_BASE_URL + PREFIX + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    let code: string | null = null;
    try {
      const j = await res.json();
      // server error envelope is { error: { code, message } } (see 409 cases in
      // contract §4); also tolerate flat { error: string } / { message: string }.
      const err = j?.error;
      if (err && typeof err === 'object') {
        if (typeof err.message === 'string') msg = err.message;
        if (typeof err.code === 'string') code = err.code;
      } else if (typeof err === 'string') {
        msg = err;
      } else if (typeof j?.message === 'string') {
        msg = j.message;
      }
      if (code == null && typeof j?.code === 'string') code = j.code;
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, msg, code);
  }
  return (await res.json()) as T;
}

/* ---- server JSON shapes (backend-contract §5) ---------------------------- */

export type ServerRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface TaskSummary {
  id: string;
  name: string;
  filePath: string | null;
  triggerSource: string | null;
  cronPattern: string | null;
  runs24h: number;
  p50Ms: number | null;
  p95Ms: number | null;
  successRate: number | null; // 0-100, null = no runs
  trend: number[]; // 12 buckets, runs per 2h over last 24h
  lastRunAt: string | null;
}

export interface TasksResponse {
  tasks: TaskSummary[];
}

export interface RunSummary {
  id: string;
  taskId: string;
  status: ServerRunStatus;
  trigger: string; // trigger_type
  codeVersion: string | null;
  env: string;
  attempt: number;
  durationMs: number | null; // null while running
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunsResponse {
  runs: RunSummary[];
  nextCursor: string | null;
}

export interface RunErrorJson {
  message: string;
  stack?: string;
  name?: string;
}

export interface RunFull {
  id: string;
  taskId: string;
  status: ServerRunStatus;
  payload: unknown;
  output: unknown;
  error: RunErrorJson | null;
  trigger: string;
  parentRunId: string | null;
  codeVersion: string | null;
  env: string;
  attempt: number;
  maxAttempts: number | null;
  idempotencyKey: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface RunStep {
  seq: number;
  kind: string; // 'step'|'wait'|'trigger-and-wait'|'batch-trigger'|'now'|'random'|'uuid'
  label: string | null;
  status: string; // 'completed'|'failed'
  output: unknown;
  error: RunErrorJson | null;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunWait {
  id: number;
  stepSeq: number | null;
  kind: string; // 'duration'|'until'|'run'
  resumeAt: string | null;
  childRunId: string | null;
  status: string; // 'pending'|'completed'|'canceled'
  createdAt: string | null;
}

export interface RunLog {
  id: number;
  stepSeq: number | null;
  level: string; // 'debug'|'info'|'warn'|'error'
  message: string;
  data: unknown;
  ts: string;
}

export interface RunDetailResponse {
  run: RunFull;
  steps: RunStep[];
  waits: RunWait[];
  logs: RunLog[];
}

export interface ScheduleSummary {
  id: string;
  taskId: string;
  cronPattern: string;
  cronTz: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ServerRunStatus | null;
}

export interface SchedulesResponse {
  schedules: ScheduleSummary[];
}

export interface WorkerSummary {
  id: string;
  name: string | null;
  codeVersion: string | null;
  runtime: string;
  tasks: string[];
  concurrency: number;
  status: string; // 'online'|'offline'
  startedAt: string | null;
  lastHeartbeatAt: string | null;
}

export interface WorkersResponse {
  workers: WorkerSummary[];
}

export interface RunFilters {
  env?: string;
  taskId?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

/* ---- endpoints (backend-contract §5) ------------------------------------- */

export const api = {
  health(signal?: AbortSignal): Promise<{ ok: boolean; version: string }> {
    return request('/health', { signal });
  },
  tasks(signal?: AbortSignal): Promise<TasksResponse> {
    return request('/tasks', { signal });
  },
  runs(filters: RunFilters = {}, signal?: AbortSignal): Promise<RunsResponse> {
    const qs = new URLSearchParams();
    // 'prod' is the default env on the server; staging/dev narrow it.
    if (filters.env && filters.env !== 'all') qs.set('env', filters.env);
    if (filters.taskId) qs.set('taskId', filters.taskId);
    if (filters.status && filters.status !== 'all') qs.set('status', filters.status);
    if (filters.limit) qs.set('limit', String(filters.limit));
    if (filters.cursor) qs.set('cursor', filters.cursor);
    const q = qs.toString();
    return request('/runs' + (q ? '?' + q : ''), { signal });
  },
  run(runId: string, signal?: AbortSignal): Promise<RunDetailResponse> {
    return request('/runs/' + encodeURIComponent(runId), { signal });
  },
  schedules(signal?: AbortSignal): Promise<SchedulesResponse> {
    return request('/schedules', { signal });
  },
  setScheduleEnabled(id: string, enabled: boolean, signal?: AbortSignal): Promise<unknown> {
    return request('/schedules/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled }, signal });
  },
  workers(signal?: AbortSignal): Promise<WorkersResponse> {
    return request('/workers', { signal });
  },
  cancelRun(runId: string, signal?: AbortSignal): Promise<unknown> {
    return request('/runs/' + encodeURIComponent(runId) + '/cancel', { method: 'POST', signal });
  },
  retryRun(runId: string, signal?: AbortSignal): Promise<{ runId: string }> {
    return request('/runs/' + encodeURIComponent(runId) + '/retry', { method: 'POST', signal });
  },
};
