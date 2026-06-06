/* =============================================================================
   better-trigger — thin typed HTTP client.
   Wraps every worker / trigger endpoint from docs/backend-contract.md §4.
   Non-2xx responses throw ApiError carrying the HTTP status and stable code.
   Uses the global fetch; no third-party dependency.
   ============================================================================= */
import type {
  BatchTriggerRequest,
  BatchTriggerResponse,
  BatchTriggerStepRequest,
  BatchTriggerStepResponse,
  CompleteRunRequest,
  DequeueResponse,
  FailRunRequest,
  FailRunResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  OkResponse,
  RegisterWorkerRequest,
  RegisterWorkerResponse,
  ReportLogsRequest,
  ReportStepRequest,
  SuspendRequest,
  SuspendResponse,
  TriggerRequest,
  TriggerResponse,
  WaitForRunRequest,
  WaitForRunResponse,
} from '@better-trigger/core';
import { resolveConfig, type SdkConfig } from './config';

/** Raised for any non-2xx response from the server. */
export class ApiError extends Error {
  readonly isBetterTriggerApiError = true;
  constructor(
    /** HTTP status code. */
    readonly status: number,
    /** Stable machine-readable code (e.g. 'run_not_running', 'task_not_found'). */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(err: unknown): err is ApiError {
  return (
    err instanceof ApiError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as Record<string, unknown>).isBetterTriggerApiError === true)
  );
}

/** True when an error is a 409 run_not_running (run was canceled / finished). */
export function isRunNotRunning(err: unknown): boolean {
  return isApiError(err) && err.status === 409 && err.code === 'run_not_running';
}

const API_PREFIX = '/api/v1';

export class HttpClient {
  private readonly config: SdkConfig;

  constructor(perCall?: Partial<SdkConfig>) {
    this.config = resolveConfig(perCall);
  }

  get apiUrl(): string {
    return this.config.apiUrl;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  /** Core request helper: JSON in, JSON out, ApiError on non-2xx. */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<T> {
    const url = `${this.config.apiUrl}${API_PREFIX}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: init?.signal,
      });
    } catch (err) {
      // Network-level failure: surface as ApiError with status 0 so callers can
      // distinguish transport errors (retry/backoff) from server rejections.
      throw new ApiError(0, 'network_error', (err as Error)?.message ?? 'network error');
    }

    const text = await res.text();
    const parsed = text ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const errBody = parsed as { error?: { code?: string; message?: string } } | undefined;
      const code = errBody?.error?.code ?? `http_${res.status}`;
      const message = errBody?.error?.message ?? res.statusText ?? `HTTP ${res.status}`;
      throw new ApiError(res.status, code, message);
    }

    return parsed as T;
  }

  /* ---- worker protocol -------------------------------------------------- */

  registerWorker(req: RegisterWorkerRequest): Promise<RegisterWorkerResponse> {
    return this.request('POST', '/workers/register', req);
  }

  heartbeat(workerId: string, req: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.request('POST', `/workers/${encodeURIComponent(workerId)}/heartbeat`, req);
  }

  /** Long-poll dequeue. `timeoutMs` is how long the server holds the connection. */
  dequeue(
    workerId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DequeueResponse> {
    const qs = `?workerId=${encodeURIComponent(workerId)}&timeoutMs=${timeoutMs}`;
    return this.request('GET', `/dequeue${qs}`, undefined, { signal });
  }

  reportStep(runId: string, req: ReportStepRequest): Promise<OkResponse> {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}/steps`, req);
  }

  suspend(runId: string, req: SuspendRequest): Promise<SuspendResponse> {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}/suspend`, req);
  }

  waitForRun(runId: string, req: WaitForRunRequest): Promise<WaitForRunResponse> {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}/wait-for-run`, req);
  }

  batchTriggerStep(
    runId: string,
    req: BatchTriggerStepRequest,
  ): Promise<BatchTriggerStepResponse> {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}/batch-trigger`, req);
  }

  completeRun(runId: string, req: CompleteRunRequest): Promise<OkResponse> {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}/complete`, req);
  }

  failRun(runId: string, req: FailRunRequest): Promise<FailRunResponse> {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}/fail`, req);
  }

  reportLogs(runId: string, req: ReportLogsRequest): Promise<OkResponse> {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}/logs`, req);
  }

  /* ---- trigger API (app code) ------------------------------------------ */

  trigger(req: TriggerRequest): Promise<TriggerResponse> {
    return this.request('POST', '/trigger', req);
  }

  batchTrigger(req: BatchTriggerRequest): Promise<BatchTriggerResponse> {
    return this.request('POST', '/batch-trigger', req);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
