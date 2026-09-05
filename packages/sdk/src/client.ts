/* =============================================================================
   better-trigger — HTTP transport.

   A thin fetch wrapper over the worker daemon's /api/v1 surface. This is the
   ONLY way this package talks to better-trigger: no Postgres driver, no
   kernel, nothing that has to run in the same process as the queue.

   Error mapping is the point of interest. The daemon answers failures with
   { error: { code, message, requestId? } }; codes that belong to the kernel
   error family are rethrown as KernelError so `err.code === 'task_not_found'`
   reads the same whether it crossed a wire or not. Everything else (transport
   failures, 401s, 5xx) becomes HttpError.

   Request bodies are encoded with core's safeSerializeJson — not raw
   JSON.stringify, which throws a TypeError on a circular structure or a
   BigInt. That local throw used to be caught by the fetch guard below and
   misreported as "is the worker daemon running?"; it now surfaces as a
   KernelError with code 'serialization_error', the same code the daemon would
   answer with if the body had reached it.
   ============================================================================= */
import { KernelError, safeSerializeJson, type KernelErrorCode } from '@better-trigger/core';

/** Failure that is not part of the kernel error family (transport, auth, 5xx). */
export class HttpError extends Error {
  constructor(
    /** HTTP status, or 0 when the request never got a response. */
    readonly status: number,
    /** Machine-readable code from the error envelope, when the server sent one. */
    readonly code: string | null,
    message: string,
    /**
     * Correlation id the daemon puts on a production `internal_error`, where
     * the message is generic: grep the server log for it to get the real error.
     * Null whenever the server sent none.
     */
    readonly requestId: string | null = null,
  ) {
    // Carried in the message too — a caller that only logs `err.message` still
    // ends up with something it can match against the daemon's log.
    super(requestId ? `${message} (requestId: ${requestId})` : message);
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
  'serialization_error',
  'payload_too_large',
  'conflict',
  // O6: the daemon's rate-limit middleware (HTTP 429).
  'rate_limited',
]);

export interface HttpClientOptions {
  /** Base URL of the worker daemon, e.g. http://localhost:4848. */
  url: string;
  /** Bearer token; required when the daemon runs with BETTER_TRIGGER_API_KEY. */
  apiKey?: string;
  /** Injectable fetch (tests, proxies, custom agents). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Per-request timeout: finite, 0 < ms <= 2147483647.
   * Default 30s; long-polls pass their own.
   */
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Caller cancellation, combined with the per-request timeout. */
  signal?: AbortSignal;
  /** Overrides the client-level timeout for this request; finite, 0 < ms <= 2147483647. */
  timeoutMs?: number;
  /**
   * Extra request headers, merged case-insensitively with the defaults: a
   * caller header and a client default that differ only in case never both
   * survive into the request (a doubled name would make fetch comma-join them).
   * Content-Type is caller-overridable; Authorization is owned by the client's
   * apiKey and cannot be overridden. See the merge in `request`.
   */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const PREFIX = '/api/v1';

/**
 * Shared timeoutMs guard for the constructor and the per-request override.
 * Reject invalid delays before allocating request resources: runtimes can
 * reduce values above the signed 32-bit timer limit to 1ms. Valid fractional
 * values pass through unchanged, retaining the runtime's timer precision.
 */
function assertTimeoutMs(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(
      `better-trigger: "timeoutMs" must be a finite number of milliseconds ` +
        `in the range 0 < timeoutMs <= ${MAX_TIMEOUT_MS} (got ${String(value)})`,
    );
  }
}

/**
 * Merge caller-supplied headers with the client defaults CASE-INSENSITIVELY
 * (01-core-sdk T7). Two headers that differ only in case must never both reach
 * fetch: it comma-joins same-name values into a single header, and a doubled
 * Content-Type trips the server's requireJsonContentType with a 400. Precedence
 * is explicit and asymmetric:
 *   - `defaults` are applied first, then the CALLER's headers win over them — so
 *     a caller can override Content-Type.
 *   - `locked` headers are applied last, winning over the caller: Authorization
 *     belongs to the client's apiKey and must not be swappable.
 * The surviving value keeps the casing it was supplied with.
 */
function mergeHeaders(
  caller: Record<string, string> | undefined,
  defaults: ReadonlyArray<readonly [string, string]>,
  locked: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const byKey = new Map<string, { name: string; value: string }>();
  const order: string[] = [];
  const put = (name: string, value: string): void => {
    const key = name.toLowerCase();
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, { name, value });
  };
  for (const [name, value] of defaults) put(name, value);
  for (const [name, value] of Object.entries(caller ?? {})) put(name, value);
  for (const [name, value] of locked) put(name, value);
  const out: Record<string, string> = {};
  for (const key of order) {
    const entry = byKey.get(key)!;
    out[entry.name] = entry.value;
  }
  return out;
}

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
    assertTimeoutMs(this.timeoutMs);
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
    // A per-request override goes through the same guard as the constructor
    // value: an invalid override must fail as a config error, not silently
    // degrade to "every request times out immediately" (throwing is chosen
    // over falling back so both call paths enforce the same contract).
    if (opts.timeoutMs !== undefined) assertTimeoutMs(opts.timeoutMs);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    // Encode the body before the timeout controller and abort listener exist:
    // a body that cannot be serialized (circular, BigInt) is the caller's
    // mistake, reported as a KernelError('serialization_error') — NOT as an
    // HttpError blaming the daemon — and it must not leave a pending timer or
    // a dangling abort listener behind.
    let bodyStr: string | undefined;
    if (body !== undefined) {
      const serialized = safeSerializeJson(body, undefined, 'request body');
      if (!serialized.ok) throw new KernelError('serialization_error', serialized.message);
      bodyStr = serialized.json;
    }

    // A signal that already fired never dispatches again, so a plain
    // addEventListener below would let the request go out on a dead signal.
    // Check it up front — a pre-aborted caller must never hit the network.
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // Propagate the caller's reason onto the internal controller so a
    // mid-flight abort surfaces THEIR reason (e.g. a run's ctx.signal reason),
    // matching the pre-abort path below.
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    // Case-insensitive header merge (T7): the caller may override Content-Type,
    // but Authorization is owned by the apiKey and is applied last.
    const headers = mergeHeaders(
      opts.headers,
      body !== undefined ? [['Content-Type', 'application/json']] : [],
      this.apiKey ? [['Authorization', `Bearer ${this.apiKey}`]] : [],
    );

    try {
      const res = await this.doFetch(this.base + PREFIX + path, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      // Body consumption stays INSIDE the timeout/abort guard (p1-15): the
      // timer is still armed and the caller's listener still attached, so a
      // slow-drip body cannot outrun timeoutMs and a mid-body caller abort
      // (e.g. a run's ctx.signal) still breaks the read. When either fires,
      // controller.abort() errors the body stream and the rejection lands in
      // the classifier below — the same timeout / abort errors as the
      // header phase.
      if (!res.ok) throw await toError(res, controller.signal);
      // A 204 has no body: `request` is typed for a JSON answer, so the value
      // it yields here is `undefined` regardless of T. Callers that expect no
      // body use requestEmpty() (which returns Promise<void>, no generic to
      // misrepresent); a JSON caller that ever meets a 204 is on the documented
      // contract that the result is undefined. The double cast makes that lie
      // explicit rather than hiding it behind a single `as T` (01-core-sdk T8).
      if (res.status === 204) return undefined as unknown as T;
      // A 2xx with a non-JSON body (a misconfigured proxy, an HTML error page
      // behind a 200) used to throw a bare SyntaxError from res.json() OUTSIDE
      // this guard — not an HttpError, not a KernelError — so callers could not
      // recognize it. Wrap it as a distinguishable HttpError(status, invalid_json).
      try {
        return (await res.json()) as T;
      } catch (err) {
        // The read died because WE aborted it (timeout or caller cancel) —
        // that is a timeout/abort, not a malformed body. Let the classifier
        // below map it; do not dress it up as invalid_json.
        if (controller.signal.aborted) throw err;
        throw new HttpError(
          res.status,
          'invalid_json',
          `better-trigger: request to ${this.base}${PREFIX}${path} answered ${res.status} with a body that is not JSON`,
        );
      }
    } catch (err) {
      // Mapped failures (toError's HttpError/KernelError, invalid_json) leave
      // untouched; everything else is a transport-phase or body-phase
      // interruption and gets classified here.
      if (err instanceof HttpError || err instanceof KernelError) throw err;
      // Caller aborted → surface their reason; our internal timeout → a
      // distinguishable HttpError (code 'timeout'); otherwise a genuine
      // transport failure (daemon down, DNS, TLS).
      if (signal?.aborted) throw err;
      if (timedOut) {
        throw new HttpError(
          0,
          'timeout',
          `better-trigger: request to ${this.base}${PREFIX}${path} timed out after ${timeoutMs}ms — the operation may or may not have been applied; for a trigger, retry with an idempotencyKey`,
        );
      }
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
  }

  /**
   * Send a request whose outcome is the status code alone — cancel and other
   * control endpoints answer `{ ok: true }` (200) or a bare 204 with nothing the
   * caller reads. This is the honest counterpart to request<T>: there is no
   * generic to violate, the return is simply void, and any non-error response
   * body is consumed and discarded (01-core-sdk T8). Error mapping and the
   * timeout/abort guard are request's, unchanged.
   */
  async requestEmpty(path: string, opts: RequestOptions = {}): Promise<void> {
    await this.request<unknown>(path, opts);
  }
}

/**
 * Turn a non-2xx response into a KernelError (known code) or HttpError.
 * `signal` is the request's internal abort signal: reading the error body
 * happens inside the timeout/abort guard too (p1-15), so when the read dies
 * because the timeout fired or the caller aborted, the abort must surface
 * (the caller classifies it as timeout/abort) instead of degrading to the
 * status-line fallback and hanging or hiding the real failure.
 */
async function toError(res: Response, signal?: AbortSignal): Promise<Error> {
  let message = res.statusText || `HTTP ${res.status}`;
  let code: string | null = null;
  let requestId: string | null = null;
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    if (body?.error && typeof body.error === 'object') {
      if (typeof body.error.message === 'string') message = body.error.message;
      if (typeof body.error.code === 'string') code = body.error.code;
      if (typeof body.error.requestId === 'string') requestId = body.error.requestId;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    /* non-JSON error body — keep the status line */
  }
  if (code && KERNEL_CODES.has(code)) {
    // KernelError messages are the daemon's own and never get redacted, so the
    // server has no reason to stamp a requestId on this branch.
    return new KernelError(code as KernelErrorCode, message);
  }
  return new HttpError(res.status, code, message, requestId);
}
