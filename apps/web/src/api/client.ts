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
  /** Extra request headers, merged under the defaults (auth, content-type). */
  headers?: Record<string, string>;
}

/**
 * Hard ceiling on a single request. A daemon that accepts the connection but
 * never finishes its response would otherwise leave the request (and the self-
 * rescheduling usePoll loop) unsettled forever: the endpoint stops polling and
 * the connection indicator never falls back. A stalled request aborts at this
 * deadline and surfaces as an ordinary poll error, so the loop keeps turning.
 */
const REQUEST_TIMEOUT_MS = 10_000;

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = opts;
  signal?.throwIfAborted();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // Combine the caller's cancellation (unmount / key change) with a timeout
  // abort, but keep them distinguishable: usePoll must swallow a deliberate
  // cancel (AbortError) yet record a timeout as a real failure.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  let timedOut = false;
  const timer = setTimeout(() => {
    if (ctrl.signal.aborted) return;
    timedOut = true;
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(API_BASE_URL + PREFIX + path, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
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
      } catch (e) {
        // An aborted body must retain its cancellation/timeout semantics;
        // only a non-JSON error body falls back to the HTTP status text.
        if (ctrl.signal.aborted) throw e;
      }
      throw new ApiError(res.status, msg, code, requestId);
    }
    return (await res.json()) as T;
  } catch (e) {
    // Keep one deadline through fetch AND body consumption. A timeout is a
    // visible poll failure, while caller cancellation keeps its original error.
    throw timedOut ? new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`) : e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
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

function nsQuery(params: URLSearchParams, env: string = 'prod'): void {
  params.set('projectId', PROJECT_ID);
  params.set('env', env);
}

export const api = {
  health(signal?: AbortSignal): Promise<{ ok: boolean; version: string }> {
    return request('/health', { signal });
  },
  tasks(env: string = 'prod', signal?: AbortSignal): Promise<TasksResponse> {
    const qs = new URLSearchParams();
    nsQuery(qs, env);
    return request('/tasks?' + qs, { signal });
  },
  runs(filters: RunFilters = {}, signal?: AbortSignal): Promise<RunsResponse> {
    const qs = new URLSearchParams();
    if (filters.taskId) qs.set('taskId', filters.taskId);
    if (filters.status && filters.status !== 'all') qs.set('status', filters.status);
    if (filters.limit) qs.set('limit', String(filters.limit));
    if (filters.cursor) qs.set('cursor', filters.cursor);
    // 'all' means "no env narrowing" (default prod) — the switcher only ever
    // sends a concrete env, but this keeps the legacy call shape harmless.
    nsQuery(qs, filters.env && filters.env !== 'all' ? filters.env : 'prod');
    const q = qs.toString();
    return request('/runs' + (q ? '?' + q : ''), { signal });
  },
  run(
    runId: string,
    env: string = 'prod',
    opts: { logsBefore?: number } = {},
    signal?: AbortSignal,
  ): Promise<RunDetailResponse> {
    const qs = new URLSearchParams();
    nsQuery(qs, env);
    // PF3 logs paging: pass the previous page's logsNextCursor to fetch the
    // older page (a long run's log tail is reached by walking the chain).
    if (opts.logsBefore != null) qs.set('logsBefore', String(opts.logsBefore));
    return request('/runs/' + encodeURIComponent(runId) + '?' + qs, { signal });
  },
  schedules(env: string = 'prod', signal?: AbortSignal): Promise<SchedulesResponse> {
    const qs = new URLSearchParams();
    nsQuery(qs, env);
    return request('/schedules?' + qs, { signal });
  },
  setScheduleEnabled(id: string, enabled: boolean, env: string = 'prod', signal?: AbortSignal): Promise<unknown> {
    const qs = new URLSearchParams();
    nsQuery(qs, env);
    return request('/schedules/' + encodeURIComponent(id) + '?' + qs, {
      method: 'PATCH',
      body: { enabled },
      signal,
    });
  },
  workers(env: string = 'prod', signal?: AbortSignal): Promise<WorkersResponse> {
    const qs = new URLSearchParams();
    nsQuery(qs, env);
    return request('/workers?' + qs, { signal });
  },
  cancelRun(runId: string, env: string = 'prod', signal?: AbortSignal): Promise<unknown> {
    const qs = new URLSearchParams();
    nsQuery(qs, env);
    return request('/runs/' + encodeURIComponent(runId) + '/cancel?' + qs, {
      method: 'POST',
      signal,
    });
  },
  /**
   * Re-run a failed/canceled run as a NEW run. `opts.operationKey` is sent as
   * the Idempotency-Key header (p2-38): repeated sends of the SAME intent
   * under the same key — a re-send while the request is still pending, a
   * proxy replaying the identical request bytes — return the FIRST call's new
   * run id instead of creating one run per delivery. Key reuse is the
   * caller's contract: the dashboard holds one key for the lifetime of an
   * in-flight retry intent and clears it when the request settles, so a fresh
   * click is a fresh intent with a fresh key. Absent → legacy semantics.
   */
  retryRun(
    runId: string,
    env: string = 'prod',
    opts?: { operationKey?: string },
    signal?: AbortSignal,
  ): Promise<{ runId: string }> {
    const qs = new URLSearchParams();
    nsQuery(qs, env);
    return request('/runs/' + encodeURIComponent(runId) + '/retry?' + qs, {
      method: 'POST',
      headers: opts?.operationKey ? { 'Idempotency-Key': opts.operationKey } : undefined,
      signal,
    });
  },
};
