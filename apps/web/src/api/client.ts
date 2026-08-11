/* =============================================================================
   Better Trigger — dashboard HTTP client.
   Thin fetch wrapper over the server's /api/v1 surface (backend-contract §5).
   Response shapes are the read models from @better-trigger/core — the same
   declarations the server builds its JSON from, so a contract change cannot
   drift past the type checker here. core is zero-dependency and these are
   `import type` only, so nothing lands in the vite bundle.
   ============================================================================= */
import type {
  LogRecord,
  RunDetailResult,
  RunRecord,
  RunsResponse as RunsResponseModel,
  RunStatus,
  RunStepRecord,
  RunSummary as RunSummaryModel,
  SchedulesResponse as SchedulesResponseModel,
  ScheduleSummary as ScheduleSummaryModel,
  SerializedError,
  TasksResponse as TasksResponseModel,
  TaskSummary as TaskSummaryModel,
  WaitRecord,
  WorkersResponse as WorkersResponseModel,
  WorkerSummary as WorkerSummaryModel,
} from '@better-trigger/core';

const viteApiKey = import.meta.env.VITE_BT_API_KEY;
let apiKey: string | null = viteApiKey?.trim() || null;
let apiKeySource: 'vite-env' | 'memory' | 'none' = apiKey ? 'vite-env' : 'none';
let apiKeyVersion = 0;
const apiKeyListeners = new Set<() => void>();

export function setApiKey(token: string | null): void {
  apiKey = token?.trim() || null;
  apiKeySource = apiKey ? 'memory' : 'none';
  apiKeyVersion += 1;
  apiKeyListeners.forEach((listener) => listener());
}

export function getApiKey(): string | null {
  return apiKey;
}

export function getApiKeySource(): 'vite-env' | 'memory' | 'none' {
  return apiKeySource;
}

export function subscribeApiKey(listener: () => void): () => void {
  apiKeyListeners.add(listener);
  return () => apiKeyListeners.delete(listener);
}

export function getApiKeyVersion(): number {
  return apiKeyVersion;
}

export const API_BASE_URL: string =
  (import.meta.env.VITE_BT_API_URL as string | undefined) ??
  // Vite dev (standalone on :5173) falls back to the daemon's default port; a
  // production build is served BY the daemon (O3), so it talks to the same
  // origin it was loaded from — no VITE_BT_API_URL, no CORS, works from any
  // host:port the daemon is reached at.
  (import.meta.env.DEV ? 'http://localhost:4848' : '');

const PREFIX = '/api/v1';

export class ApiError extends Error {
  status: number;
  /** machine-readable code from the server error envelope, when present. */
  code: string | null;
  /**
   * Correlation id the daemon stamps on a production `internal_error` (the
   * message there is generic): grep the server log for it to get the real
   * error. Absent unless the envelope carried one.
   */
  requestId?: string;
  constructor(status: number, message: string, code: string | null = null, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(API_BASE_URL + PREFIX + path, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    let code: string | null = null;
    let requestId: string | undefined;
    try {
      const j = await res.json();
      // server error envelope is { error: { code, message } } (see 409 cases in
      // contract §4); also tolerate flat { error: string } / { message: string }.
      // Production internal_error adds requestId to the envelope — parsed the
      // same way the SDK's HttpError does.
      const err = j?.error;
      if (err && typeof err === 'object') {
        if (typeof err.message === 'string') msg = err.message;
        if (typeof err.code === 'string') code = err.code;
        if (typeof err.requestId === 'string') requestId = err.requestId;
      } else if (typeof err === 'string') {
        msg = err;
      } else if (typeof j?.message === 'string') {
        msg = j.message;
      }
      if (code == null && typeof j?.code === 'string') code = j.code;
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, msg, code, requestId);
  }
  return (await res.json()) as T;
}

/* ---- server JSON shapes (backend-contract §5) ---------------------------- */

/*
 * The run ledger is core's read models verbatim — local aliases keep the names
 * the dashboard already uses (and `ServerRunStatus` keeps the wire vocabulary
 * distinguishable from the UI one in src/types.ts, which is also `RunStatus`).
 */
export type ServerRunStatus = RunStatus;
export type RunErrorJson = SerializedError;
export type RunFull = RunRecord;
export type RunStep = RunStepRecord;
export type RunWait = WaitRecord;
export type RunLog = LogRecord;
export type RunDetailResponse = RunDetailResult;

/*
 * The list/summary projections are core's read models too, so the dashboard's
 * enums (task trigger source, worker status, run status) are the server's own
 * unions instead of bare `string` — comparing against a value that is no longer
 * in the contract is now a type error.
 */
export type TaskSummary = TaskSummaryModel;
export type TasksResponse = TasksResponseModel;
export type RunSummary = RunSummaryModel;
export type RunsResponse = RunsResponseModel;
export type ScheduleSummary = ScheduleSummaryModel;
export type SchedulesResponse = SchedulesResponseModel;
export type WorkerSummary = WorkerSummaryModel;
export type WorkersResponse = WorkersResponseModel;

export interface RunFilters {
  /** Project scope of the runs list (default 'default' — the server-side
   *  namespace default). */
  projectId?: string;
  env?: string;
  taskId?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

/* ---- endpoints (backend-contract §5) ------------------------------------- */

/**
 * Every read/control call names the namespace it means. The server defaults
 * missing params to default/prod, but the dashboard says it explicitly: the
 * "single namespace by default" visibility boundary is a property of the UI,
 * not something it stumbles into. projectId stays 'default' (there is no
 * project switcher in the UI); env follows the TopBar's EnvSwitcher.
 */
const PROJECT_ID = 'default';

function nsQuery(params: URLSearchParams): void {
  params.set('projectId', PROJECT_ID);
}

export const api = {
  health(signal?: AbortSignal): Promise<{ ok: boolean; version: string }> {
    return request('/health', { signal });
  },
  tasks(signal?: AbortSignal): Promise<TasksResponse> {
    const qs = new URLSearchParams();
    nsQuery(qs);
    return request('/tasks?' + qs, { signal });
  },
  runs(filters: RunFilters = {}, signal?: AbortSignal): Promise<RunsResponse> {
    const qs = new URLSearchParams();
    // 'prod' is the default env on the server; staging/dev narrow it.
    if (filters.env && filters.env !== 'all') qs.set('env', filters.env);
    if (filters.taskId) qs.set('taskId', filters.taskId);
    if (filters.status && filters.status !== 'all') qs.set('status', filters.status);
    if (filters.limit) qs.set('limit', String(filters.limit));
    if (filters.cursor) qs.set('cursor', filters.cursor);
    nsQuery(qs);
    const q = qs.toString();
    return request('/runs' + (q ? '?' + q : ''), { signal });
  },
  run(runId: string, opts: { logsBefore?: number } = {}, signal?: AbortSignal): Promise<RunDetailResponse> {
    const qs = new URLSearchParams({ projectId: PROJECT_ID });
    // PF3 logs paging: pass the previous page's logsNextCursor to fetch the
    // older page (a long run's log tail is reached by walking the chain).
    if (opts.logsBefore != null) qs.set('logsBefore', String(opts.logsBefore));
    return request('/runs/' + encodeURIComponent(runId) + '?' + qs, { signal });
  },
  schedules(signal?: AbortSignal): Promise<SchedulesResponse> {
    return request('/schedules?projectId=' + PROJECT_ID, { signal });
  },
  setScheduleEnabled(id: string, enabled: boolean, signal?: AbortSignal): Promise<unknown> {
    return request('/schedules/' + encodeURIComponent(id) + '?projectId=' + PROJECT_ID, {
      method: 'PATCH',
      body: { enabled },
      signal,
    });
  },
  workers(signal?: AbortSignal): Promise<WorkersResponse> {
    return request('/workers?projectId=' + PROJECT_ID, { signal });
  },
  cancelRun(runId: string, signal?: AbortSignal): Promise<unknown> {
    return request('/runs/' + encodeURIComponent(runId) + '/cancel?projectId=' + PROJECT_ID, {
      method: 'POST',
      signal,
    });
  },
  retryRun(runId: string, signal?: AbortSignal): Promise<{ runId: string }> {
    return request('/runs/' + encodeURIComponent(runId) + '/retry?projectId=' + PROJECT_ID, {
      method: 'POST',
      signal,
    });
  },
};
