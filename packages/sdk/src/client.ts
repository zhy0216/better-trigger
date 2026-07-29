/* =============================================================================
   better-trigger — HTTP transport.

   A thin fetch wrapper over the worker daemon's /api/v1 surface. This is the
   ONLY way this package talks to better-trigger: no Postgres driver, no
   kernel, nothing that has to run in the same process as the queue.

   Error mapping is the point of interest. The daemon answers failures with
   { error: { code, message } }; codes that belong to the kernel error family
   are rethrown as KernelError so `err.code === 'task_not_found'` reads the
   same whether it crossed a wire or not. Everything else (transport failures,
   401s, 5xx) becomes HttpError.
   ============================================================================= */
import { KernelError, type KernelErrorCode } from '@better-trigger/core';

/** Failure that is not part of the kernel error family (transport, auth, 5xx). */
export class HttpError extends Error {
  constructor(
    /** HTTP status, or 0 when the request never got a response. */
    readonly status: number,
    /** Machine-readable code from the error envelope, when the server sent one. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Codes the daemon maps from KernelError — rethrown as KernelError client-side. */
const KERNEL_CODES = new Set<string>([
  'not_found',
  'run_not_running',
  'stale_lease',
  'task_not_found',
  'bad_request',
  'conflict',
]);

export interface HttpClientOptions {
  /** Base URL of the worker daemon, e.g. http://localhost:4848. */
  url: string;
  /** Bearer token; required when the daemon runs with BETTER_TRIGGER_API_KEY. */
  apiKey?: string;
  /** Injectable fetch (tests, proxies, custom agents). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms. Default 30s; long-polls pass their own. */
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Caller cancellation, combined with the per-request timeout. */
  signal?: AbortSignal;
  /** Overrides the client-level timeout for this request. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PREFIX = '/api/v1';

export class HttpClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    if (!opts.url) throw new Error('better-trigger: "url" is required');
    // Trailing slashes would double up against the /api/v1 prefix.
    this.base = opts.url.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error(
        'better-trigger: global fetch is unavailable — use Node 18+ or pass options.fetch',
      );
    }
    // Bind: an unbound global fetch throws "Illegal invocation" in some runtimes.
    this.doFetch = f.bind(globalThis);
  }

  get baseUrl(): string {
    return this.base;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, signal } = opts;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await this.doFetch(this.base + PREFIX + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // Caller aborted → surface their reason; otherwise it was our timeout or
      // a genuine transport failure (daemon down, DNS, TLS).
      if (signal?.aborted) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new HttpError(
        0,
        null,
        `better-trigger: request to ${this.base}${PREFIX}${path} failed (${detail}) — is the worker daemon running?`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/** Turn a non-2xx response into a KernelError (known code) or HttpError. */
async function toError(res: Response): Promise<Error> {
  let message = res.statusText || `HTTP ${res.status}`;
  let code: string | null = null;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error && typeof body.error === 'object') {
      if (typeof body.error.message === 'string') message = body.error.message;
      if (typeof body.error.code === 'string') code = body.error.code;
    }
  } catch {
    /* non-JSON error body — keep the status line */
  }
  if (code && KERNEL_CODES.has(code)) {
    return new KernelError(code as KernelErrorCode, message);
  }
  return new HttpError(res.status, code, message);
}
