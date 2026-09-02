/* =============================================================================
   better-trigger — betterTrigger() client facade.

   One instance = one worker daemon URL. Everything here is HTTP: this package
   never opens a database connection, and it does not execute tasks. Execution
   lives in the daemon (`better-trigger-worker --tasks ./src/tasks.ts`), which
   loads the same task modules your app imports.

   The first instance created becomes the module-level default that
   instance-free TaskHandles route through when triggered outside a run.
   ============================================================================= */
import type {
  CreatedRun,
  Namespace,
  RetryRunOptions,
  RunDetailResult,
  RunRecord,
  RunStatus,
  TriggerOptions,
  WaitForResultOptions,
  WaitResult,
} from '@better-trigger/core';
import { DEFAULT_NAMESPACE, KernelError } from '@better-trigger/core';
import { HttpClient, HttpError, type HttpClientOptions } from './client';
import { applyConcurrencyKey } from './concurrency';
import { registry } from './registry';
import type { BatchItemOptions, BatchNamespaceOptions, TaskHandle } from './task';

/**
 * Thrown by waitForResult / RunHandle.result() when `throwOnTimeout` is set and
 * the wait budget runs out before the run reaches a terminal state. `status` is
 * the latest status observed — undefined only when no poll ever succeeded (e.g.
 * every attempt hit a retriable 5xx / transport failure before the deadline).
 */
export class ResultTimeoutError extends Error {
  readonly status: RunStatus | undefined;
  constructor(runId: string, timeoutMs: number, status: RunStatus | undefined) {
    super(
      `run ${runId} did not reach a terminal state within ${timeoutMs}ms` +
        (status !== undefined ? ` (status ${status})` : ''),
    );
    this.name = 'ResultTimeoutError';
    this.status = status;
  }
}

/** Returned by trigger / batchTrigger: the run id plus a result() poller. */
export interface RunHandle<TOutput = unknown> {
  /** Run id. */
  id: string;
  /**
   * true when an idempotencyKey matched an existing run, so this call returned
   * that run instead of creating one. Only set by trigger() — undefined on
   * handles minted anywhere else.
   */
  idempotent?: boolean;
  /**
   * Wait for the run to reach a terminal state. On timeout (default 30s) the
   * latest non-terminal status is returned — check `status`; pass
   * `{ throwOnTimeout: true }` to throw ResultTimeoutError instead (p2-23).
   */
  result(opts?: WaitForResultOptions): Promise<WaitResult<TOutput>>;
}

export interface BetterTriggerOptions {
  /**
   * Worker daemon base URL. Defaults to BETTER_TRIGGER_URL, then
   * http://localhost:4848.
   */
  url?: string;
  /** Bearer token; required when the daemon sets BETTER_TRIGGER_API_KEY.
   *  Defaults to the BETTER_TRIGGER_API_KEY env var. */
  apiKey?: string;
  /** Injectable fetch (tests, proxies, custom agents). Defaults to global fetch. */
  fetch?: HttpClientOptions['fetch'];
  /** Per-request timeout in ms (default 30s). Long-polls manage their own. */
  timeoutMs?: number;
}

/**
 * One item of an instance-level batchTrigger call. Same shape as core's
 * TriggerItem but with the namespace pair removed from per-item options: a
 * batch runs all-or-nothing in the ONE namespace named by the batch-level
 * `options`, so a per-item env/projectId used to typecheck and then be
 * silently dropped — a staging intent creating prod runs. Now it is a
 * compile error instead (p2-19, matching BatchItemOptions from p1-15).
 */
export interface BatchTriggerItem {
  taskId: string;
  payload: unknown;
  options?: BatchItemOptions;
}

export interface BetterTrigger {
  /** Base URL this instance talks to. */
  readonly url: string;

  /**
   * Trigger one run of a task (by handle or id). The output type flows when a
   * TaskHandle is passed (it knows its TOutput); triggering by a raw task id
   * yields a `RunHandle<unknown>` — the instance cannot know a string id's
   * output type.
   */
  trigger<TPayload, TOutput = unknown>(
    taskOrId: TaskHandle<TPayload, TOutput> | string,
    payload: TPayload,
    options?: TriggerOptions,
  ): Promise<RunHandle<TOutput>>;
  /**
   * Trigger many runs in one all-or-nothing transaction. `options` (projectId
   * / env only) names the namespace the whole batch runs in; absent →
   * default/prod. Per-item options are data — they never split a batch across
   * namespaces, so per-item env/projectId are a compile error (p2-19, same
   * narrowing TaskHandle.batchTrigger got in p1-15). The batch-level type is
   * likewise narrowed to the pair the server reads: a batch-level delay /
   * priority / idempotencyKey compiled before and was silently dropped
   * (01-core-sdk T3).
   */
  batchTrigger(
    items: BatchTriggerItem[],
    options?: BatchNamespaceOptions,
  ): Promise<RunHandle[]>;
  /**
   * Cancel a non-terminal run (terminal → no-op). `namespace` scopes the
   * request; absent → server default (default/prod).
   */
  cancelRun(runId: string, namespace?: Namespace): Promise<void>;
  /**
   * Re-run a failed/canceled run as a NEW run. `namespace` scopes the request;
   * absent → server default (default/prod). `opts.operationKey` makes the call
   * idempotent (sent as the Idempotency-Key header, p2-38): re-sending the
   * same key — a timeout replay, a proxy retry — returns the FIRST call's new
   * run id instead of creating one run per delivery. Absent → legacy
   * semantics, every call is a fresh retry.
   */
  retryRun(runId: string, namespace?: Namespace, opts?: RetryRunOptions): Promise<{ runId: string }>;
  /**
   * Full run record. `namespace` scopes the request; absent → server default
   * (default/prod).
   */
  getRun(runId: string, namespace?: Namespace): Promise<RunRecord>;
  /**
   * Run + steps + waits + logs from one REPEATABLE READ snapshot (PF3). Logs
   * are the NEWEST page (200 lines) by default; pass `opts.logsBefore` (the
   * previous response's `logsNextCursor`) to fetch the older page, until the
   * cursor is null. `namespace` scopes the request; absent → server default
   * (default/prod).
   */
  getRunDetail(
    runId: string,
    namespace?: Namespace,
    opts?: { logsBefore?: number },
  ): Promise<RunDetailResult>;
  /**
   * Wait for a run to reach a terminal state. On timeout (default 30s) the
   * latest non-terminal status is returned — pass `{ throwOnTimeout: true }`
   * to throw ResultTimeoutError instead. `namespace` scopes the poll; absent
   * → default/prod. RunHandle.result() passes the namespace its handle was
   * minted with, so callers only need this when polling a run id they got out
   * of band.
   */
  waitForResult<T = unknown>(runId: string, opts?: WaitForResultOptions): Promise<WaitResult<T>>;
  waitForResult<T = unknown>(
    runId: string,
    namespace?: Namespace,
    opts?: WaitForResultOptions,
  ): Promise<WaitResult<T>>;
  /** Daemon liveness probe. */
  health(): Promise<{ ok: boolean; version: string }>;

  /** Make this instance the module-level default used by TaskHandle triggers. */
  setDefault(): void;
}

const DEFAULT_URL = 'http://localhost:4848';
/** Cap on a single long-poll request; longer waits are looped client-side so
 *  no single HTTP request sits open long enough for a proxy to cut it. */
const MAX_LONGPOLL_MS = 25_000;
const TERMINAL: readonly RunStatus[] = ['completed', 'failed', 'canceled'];

/* ---------------------------------------------------------------------------
 * Default-instance registry (process-wide — see ./registry)
 * ------------------------------------------------------------------------- */

/** Anything able to poll a run to a terminal state. */
export interface RunResultResolver {
  waitForResult(runId: string, namespace?: Namespace, opts?: WaitForResultOptions): Promise<WaitResult>;
}

/**
 * Overrides where RunHandle.result() reads from. The worker daemon installs a
 * kernel-backed resolver at startup, so handles minted inside a run resolve
 * against the database directly instead of looping back over HTTP. The
 * resolver's waitForResult is non-generic on purpose: a kernel-backed resolver
 * cannot know a handle's TOutput — RunHandle.result() casts to it.
 */
export function setResultResolver(resolver: RunResultResolver | null): void {
  registry.resultResolver = resolver;
}

/** Internal host lifecycle seam: embedded runtimes snapshot and restore the
 * resolver they replace, instead of leaving a stopped runtime installed in
 * the process-wide registry. Not exported from the public package surface. */
export function getResultResolver(): RunResultResolver | null {
  return registry.resultResolver;
}

/** Internal host lifecycle seam; see getResultResolver(). */
export function getDefaultInstance(): BetterTrigger | null {
  return registry.defaultInstance;
}

/** Internal host lifecycle seam; see getResultResolver(). */
export function setDefaultInstance(instance: BetterTrigger | null): void {
  registry.defaultInstance = instance;
}

/** The default instance instance-free TaskHandles use outside a run. */
export function requireDefaultInstance(): BetterTrigger {
  if (!registry.defaultInstance) {
    throw new Error(
      'No betterTrigger instance registered — call betterTrigger({ url }) first',
    );
  }
  return registry.defaultInstance;
}

/**
 * Build a RunHandle. Handles minted by an instance bind result() to it;
 * handles minted inside a run resolve the installed resolver (worker) or the
 * default instance lazily, at result() call time. `namespace` — the scope the
 * run was created in — rides along so result() polls that exact scope.
 *
 * Generic over the run's output type so a TaskHandle (which knows its TOutput)
 * can mint typed handles; an instance mints `RunHandle<unknown>` because a raw
 * task id carries no output type (p2-23).
 */
export function makeRunHandle<TOutput = unknown>(
  id: string,
  instance?: BetterTrigger,
  idempotent?: boolean,
  namespace?: Namespace,
): RunHandle<TOutput> {
  return {
    id,
    idempotent,
    result: (opts) => {
      const target = instance ?? registry.resultResolver ?? registry.defaultInstance;
      if (!target) {
        // Reject (not throw): result() is async-consistent, so await/catch
        // works whether the handle resolved its target or not.
        return Promise.reject(
          new Error(`run ${id}: cannot await a result — no betterTrigger instance registered`),
        );
      }
      return target.waitForResult(id, namespace, opts) as Promise<WaitResult<TOutput>>;
    },
  };
}

/* ---------------------------------------------------------------------------
 * Factory
 * ------------------------------------------------------------------------- */

function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
}

/**
 * The namespace a trigger call means: projectId/env from its options, default
 * 'default'/'prod'. Resolution is a plain default here — validation happens
 * server-side (assertNamespace → 400 bad_request) so the client never guesses
 * what the daemon accepts.
 */
function nsFromOptions(options: TriggerOptions | undefined): Namespace {
  return {
    projectId: options?.projectId ?? DEFAULT_NAMESPACE.projectId,
    env: options?.env ?? DEFAULT_NAMESPACE.env,
  };
}

/**
 * The `?projectId=&env=` query that scopes a run-id request; empty when no
 * namespace was given (the server defaults to default/prod). Same shape the
 * waitForResult long-poll uses.
 */
function nsQuery(namespace: Namespace | undefined): string {
  if (namespace === undefined) return '';
  return `?${new URLSearchParams({ projectId: namespace.projectId, env: namespace.env })}`;
}

/**
 * Distinguish a `Namespace` (`{ projectId: string; env: string }`) from the
 * `WaitForResultOptions` shape (`{ timeoutMs?, pollMs?, signal?,
 * throwOnTimeout? }`) — the two object shapes `waitForResult` overloads accept
 * as their second argument. Only a Namespace carries string `projectId`/`env`.
 */
function isNamespace(a: unknown): a is Namespace {
  return (
    typeof a === 'object' &&
    a !== null &&
    typeof (a as Namespace).projectId === 'string' &&
    typeof (a as Namespace).env === 'string'
  );
}

/* ---------------------------------------------------------------------------
 * waitForResult retry helpers
 * ------------------------------------------------------------------------- */

/** ±20% jitter on a backoff base, so N callers retrying in lockstep don't
 *  thundering-herd one target. */
function jitter(ms: number): number {
  return ms * (0.8 + Math.random() * 0.4);
}

/** Backoff sleep, interruptible by the caller's signal. Abort rejects with the
 *  signal's reason (falling back to a plain Error, matching client.ts's
 *  pre-abort path) so a caller aborting mid-backoff is answered immediately
 *  instead of after the sleep (up to 2s, p2-12). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Errors worth another hop. KernelErrors (e.g. not_found) and 4xx are
 *  deterministic answers — retrying cannot change them. Transport failures
 *  (status 0: daemon down, proxy cut, timeout) and server 5xx (transient, or
 *  the deliberate WaiterRegistryStoppedError shutdown 5xx) may clear on the
 *  next attempt, ideally against a different daemon. The one KernelError that
 *  IS transient is 'rate_limited' (429): by definition it clears once the
 *  window rolls over, so the poll backs off and retries instead of failing a
 *  perfectly healthy wait at the first throttled hop (01-core-sdk T6). */
function isRetriable(err: unknown): boolean {
  if (err instanceof KernelError) return err.code === 'rate_limited';
  return err instanceof HttpError && (err.status === 0 || err.status >= 500);
}

/**
 * Create a better-trigger client bound to a worker daemon. Returns
 * synchronously; nothing is contacted until the first call.
 */
export function betterTrigger(options: BetterTriggerOptions = {}): BetterTrigger {
  const url = options.url ?? env('BETTER_TRIGGER_URL') ?? DEFAULT_URL;
  const http = new HttpClient({
    url,
    apiKey: options.apiKey ?? env('BETTER_TRIGGER_API_KEY'),
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });

  const instance: BetterTrigger = {
    url: http.baseUrl,

    async trigger(taskOrId, payload, options) {
      let taskId: string;
      let opts = options;
      if (typeof taskOrId === 'string') {
        taskId = taskOrId;
      } else {
        // Same concurrency-key derivation as TaskHandle: explicit option wins
        // (shared applyConcurrencyKey, 01-core-sdk T10).
        taskId = taskOrId.id;
        opts = applyConcurrencyKey(options, taskOrId.__definition.concurrency?.key?.(payload));
      }
      const created = await http.request<CreatedRun>('/trigger', {
        method: 'POST',
        body: { taskId, payload, options: opts },
      });
      // The handle remembers the namespace it was created in, so its result()
      // polls the same scope.
      return makeRunHandle(created.runId, instance, created.idempotent, nsFromOptions(opts));
    },

    async batchTrigger(items, options) {
      const res = await http.request<{ runIds: string[] }>('/batch-trigger', {
        method: 'POST',
        body: { items, options },
      });
      return res.runIds.map((id) => makeRunHandle(id, instance, undefined, nsFromOptions(options)));
    },

    async cancelRun(runId, namespace) {
      // Control endpoint: its result is a status, not data (the daemon answers
      // `{ ok: true }` / a bare 204), so it goes through requestEmpty rather
      // than a `request<T>` whose generic there would be a lie (01-core-sdk T8).
      await http.requestEmpty(`/runs/${encodeURIComponent(runId)}/cancel${nsQuery(namespace)}`, {
        method: 'POST',
      });
    },

    retryRun(runId, namespace, opts) {
      return http.request<{ runId: string }>(
        `/runs/${encodeURIComponent(runId)}/retry${nsQuery(namespace)}`,
        {
          method: 'POST',
          headers: opts?.operationKey ? { 'Idempotency-Key': opts.operationKey } : undefined,
        },
      );
    },

    getRun(runId, namespace) {
      return http.request<RunRecord>(`/runs/${encodeURIComponent(runId)}/record${nsQuery(namespace)}`);
    },

    getRunDetail(runId, namespace, opts) {
      const qs = nsQuery(namespace);
      const cursor = opts?.logsBefore !== undefined ? `logsBefore=${opts.logsBefore}` : '';
      return http.request<RunDetailResult>(
        `/runs/${encodeURIComponent(runId)}${qs}${cursor ? (qs ? '&' : '?') + cursor : ''}`,
      );
    },

    /**
     * Poll until terminal, retrying transient failures within the caller's
     * budget. Retry contract: a 5xx, a transport failure (HttpError status 0
     * — daemon unreachable, a proxy cut the long-poll, a timeout), or a
     * rate_limited (429) KernelError is retried with jittered exponential
     * backoff while budget remains — the daemon is designed for this (a redeploy
     * answers in-flight waiters with a 5xx so the SDK hops to another daemon).
     * When the budget is exhausted the LAST error is thrown, never a fabricated
     * terminal status. Other 4xx and KernelErrors (e.g. not_found) fail
     * immediately: retrying cannot change them. With `throwOnTimeout: true`,
     * budget exhaustion throws ResultTimeoutError (with the latest observed
     * status) instead of returning the latest non-terminal status / the last
     * error (p2-23).
     *
     * `timeoutMs` must be a positive number of milliseconds; NaN / 0 / negative
     * is rejected as a config error rather than arming a deadline that never (or
     * immediately) fires. `Infinity` is honored as "wait indefinitely" — every
     * hop still caps at MAX_LONGPOLL_MS, but the loop has no terminal deadline.
     */
    async waitForResult<T = unknown>(
      runId: string,
      a?: Namespace | WaitForResultOptions,
      b?: WaitForResultOptions,
    ) {
      const namespace = isNamespace(a) ? a : undefined;
      // A half namespace — one of projectId/env present as a string but not the
      // other — is a mistake, not an options object. Without this it fell through
      // to the `opts` slot and the run silently polled default/prod (01-core-sdk
      // T5). The overloads already keep a well-formed Namespace vs options
      // distinct; this catches the untyped (JS) case.
      if (a !== undefined && namespace === undefined) {
        const half = a as Partial<Namespace>;
        const hasProjectId = typeof half.projectId === 'string';
        const hasEnv = typeof half.env === 'string';
        if (hasProjectId !== hasEnv) {
          throw new Error(
            `better-trigger: waitForResult namespace must set both projectId and env ` +
              `(got ${hasProjectId ? 'projectId' : 'env'} without ${hasProjectId ? 'env' : 'projectId'})`,
          );
        }
      }
      // `a` occupies the namespace slot when it is a Namespace or undefined
      // (opts then lives in `b`); otherwise the two-arg form placed opts in `a`.
      // isNamespace(a) keeps `a` narrowed to WaitForResultOptions in the else.
      const opts = isNamespace(a) || a === undefined ? b : a;
      const timeoutMs = opts?.timeoutMs ?? 30_000;
      if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
        throw new Error(
          `better-trigger: waitForResult "timeoutMs" must be a positive number of milliseconds ` +
            `(Infinity waits indefinitely), got ${String(timeoutMs)}`,
        );
      }
      const deadline = Date.now() + timeoutMs;
      const pollMs = opts?.pollMs;
      // Backoff base: 200ms, ×2 per retry, capped at 2s, ±20% jitter.
      let backoffMs = 200;
      // Latest status a successful poll observed — what a ResultTimeoutError
      // reports when the budget runs out.
      let lastStatus: RunStatus | undefined;
      for (;;) {
        // Each hop long-polls server-side for at most MAX_LONGPOLL_MS; the
        // remaining budget can be 0, which asks for a single immediate read.
        // Floored so a fractional budget still sends an integer timeoutMs — a
        // fractional value makes the server's intQuery fall back to its 5s
        // default long-poll and overshoot the budget (01-core-sdk T5).
        const slice = Math.floor(Math.max(0, Math.min(deadline - Date.now(), MAX_LONGPOLL_MS)));
        const query = new URLSearchParams({ timeoutMs: String(slice) });
        if (pollMs !== undefined) query.set('pollMs', String(pollMs));
        // Namespace travels as query params, matching the runs routes
        // (?projectId=&env=); the server defaults to default/prod when absent.
        if (namespace !== undefined) {
          query.set('projectId', namespace.projectId);
          query.set('env', namespace.env);
        }
        let res: WaitResult<T>;
        try {
          res = await http.request<WaitResult<T>>(
            `/runs/${encodeURIComponent(runId)}/result?${query}`,
            // Give the request headroom over the server-side wait it asked for.
            { timeoutMs: slice + 10_000, signal: opts?.signal },
          );
        } catch (err) {
          // Non-retriable (4xx / KernelError) fail immediately no matter what.
          if (!isRetriable(err)) throw err;
          // Budget spent on retriable errors: throwOnTimeout turns the last
          // error into ResultTimeoutError; the default throws the last error.
          if (Date.now() >= deadline) {
            if (opts?.throwOnTimeout) throw new ResultTimeoutError(runId, timeoutMs, lastStatus);
            throw err;
          }
          // Clamp the backoff to the remaining budget — never overshoot the
          // caller's deadline, and skip the sleep entirely when nothing is
          // left.
          const sleepMs = Math.min(jitter(backoffMs), deadline - Date.now());
          if (sleepMs > 0) await sleep(sleepMs, opts?.signal);
          backoffMs = Math.min(backoffMs * 2, 2000);
          continue;
        }
        // A poll that got a response (terminal or not) resets the backoff.
        backoffMs = 200;
        lastStatus = res.status;
        if (TERMINAL.includes(res.status)) return res;
        if (Date.now() >= deadline) {
          // The server returned a live (non-terminal) answer at/after the
          // deadline: that IS the timeout outcome. throwOnTimeout throws with
          // the latest status; the default returns it (p2-23).
          if (opts?.throwOnTimeout) throw new ResultTimeoutError(runId, timeoutMs, lastStatus);
          return res;
        }
      }
    },

    health() {
      return http.request<{ ok: boolean; version: string }>('/health');
    },

    setDefault() {
      registry.defaultInstance = instance;
    },
  };

  // The first instance becomes the default (later instances may take over
  // explicitly via setDefault()).
  registry.defaultInstance ??= instance;

  return instance;
}
