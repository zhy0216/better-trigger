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
  RunDetailResult,
  RunRecord,
  RunStatus,
  TriggerItem,
  TriggerOptions,
  WaitForResultOptions,
  WaitResult,
} from '@better-trigger/core';
import { DEFAULT_NAMESPACE, KernelError } from '@better-trigger/core';
import { HttpClient, HttpError, type HttpClientOptions } from './client';
import { registry } from './registry';
import type { TaskHandle } from './task';

/** Returned by trigger / batchTrigger: the run id plus a result() poller. */
export interface RunHandle {
  /** Run id. */
  id: string;
  /**
   * true when an idempotencyKey matched an existing run, so this call returned
   * that run instead of creating one. Only set by trigger() — undefined on
   * handles minted anywhere else.
   */
  idempotent?: boolean;
  /** Wait for the run to reach a terminal state (timeout → latest status). */
  result(opts?: WaitForResultOptions): Promise<WaitResult>;
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

export interface BetterTrigger {
  /** Base URL this instance talks to. */
  readonly url: string;

  /** Trigger one run of a task (by handle or id). */
  trigger<TPayload = unknown>(
    taskOrId: TaskHandle<TPayload, any> | string,
    payload: TPayload,
    options?: TriggerOptions,
  ): Promise<RunHandle>;
  /**
   * Trigger many runs in one all-or-nothing transaction. `options` (projectId
   * / env only) names the namespace the whole batch runs in; absent →
   * default/prod. Per-item options are data — they never split a batch across
   * namespaces.
   */
  batchTrigger(items: TriggerItem[], options?: TriggerOptions): Promise<RunHandle[]>;
  /**
   * Cancel a non-terminal run (terminal → no-op). `namespace` scopes the
   * request; absent → server default (default/prod).
   */
  cancelRun(runId: string, namespace?: Namespace): Promise<void>;
  /**
   * Re-run a failed/canceled run as a NEW run. `namespace` scopes the request;
   * absent → server default (default/prod).
   */
  retryRun(runId: string, namespace?: Namespace): Promise<{ runId: string }>;
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
   * Wait for a run to reach a terminal state (timeout → latest status).
   * `namespace` scopes the poll; absent → default/prod. RunHandle.result()
   * passes the namespace its handle was minted with, so callers only need this
   * when polling a run id they got out of band.
   */
  waitForResult(
    runId: string,
    namespace: Namespace | undefined,
    opts?: WaitForResultOptions,
  ): Promise<WaitResult>;
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
  waitForResult(
    runId: string,
    namespace: Namespace | undefined,
    opts?: WaitForResultOptions,
  ): Promise<WaitResult>;
}

/**
 * Overrides where RunHandle.result() reads from. The worker daemon installs a
 * kernel-backed resolver at startup, so handles minted inside a run resolve
 * against the database directly instead of looping back over HTTP.
 */
export function setResultResolver(resolver: RunResultResolver | null): void {
  registry.resultResolver = resolver;
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
 */
export function makeRunHandle(
  id: string,
  instance?: BetterTrigger,
  idempotent?: boolean,
  namespace?: Namespace,
): RunHandle {
  return {
    id,
    idempotent,
    result: (opts) => {
      const target = instance ?? registry.resultResolver ?? registry.defaultInstance;
      if (!target) {
        throw new Error(
          `run ${id}: cannot await a result — no betterTrigger instance registered`,
        );
      }
      return target.waitForResult(id, namespace, opts);
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

/* ---------------------------------------------------------------------------
 * waitForResult retry helpers
 * ------------------------------------------------------------------------- */

/** ±20% jitter on a backoff base, so N callers retrying in lockstep don't
 *  thundering-herd one target. */
function jitter(ms: number): number {
  return ms * (0.8 + Math.random() * 0.4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Errors worth another hop. KernelErrors (e.g. not_found) and 4xx are
 *  deterministic answers — retrying cannot change them. Transport failures
 *  (status 0: daemon down, proxy cut, timeout) and server 5xx (transient, or
 *  the deliberate WaiterRegistryStoppedError shutdown 5xx) may clear on the
 *  next attempt, ideally against a different daemon. */
function isRetriable(err: unknown): boolean {
  if (err instanceof KernelError) return false;
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
        // Same concurrency-key derivation as TaskHandle: explicit option wins.
        taskId = taskOrId.id;
        const key =
          options?.concurrencyKey ?? taskOrId.__definition.concurrency?.key?.(payload);
        if (key !== undefined) opts = { ...options, concurrencyKey: key };
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
      await http.request(`/runs/${encodeURIComponent(runId)}/cancel${nsQuery(namespace)}`, {
        method: 'POST',
      });
    },

    retryRun(runId, namespace) {
      return http.request<{ runId: string }>(
        `/runs/${encodeURIComponent(runId)}/retry${nsQuery(namespace)}`,
        { method: 'POST' },
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
     * budget. Retry contract: a 5xx or a transport failure (HttpError status 0
     * — daemon unreachable, a proxy cut the long-poll, a timeout) is retried
     * with jittered exponential backoff while budget remains — the daemon is
     * designed for this (a redeploy answers in-flight waiters with a 5xx so
     * the SDK hops to another daemon). When the budget is exhausted the LAST
     * error is thrown, never a fabricated terminal status. 4xx and
     * KernelErrors (e.g. not_found) fail immediately: retrying cannot change
     * them.
     */
    async waitForResult(runId, namespace, opts) {
      const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
      const pollMs = opts?.pollMs;
      // Backoff base: 200ms, ×2 per retry, capped at 2s, ±20% jitter.
      let backoffMs = 200;
      for (;;) {
        // Each hop long-polls server-side for at most MAX_LONGPOLL_MS; the
        // remaining budget can be 0, which asks for a single immediate read.
        const slice = Math.max(0, Math.min(deadline - Date.now(), MAX_LONGPOLL_MS));
        const query = new URLSearchParams({ timeoutMs: String(slice) });
        if (pollMs !== undefined) query.set('pollMs', String(pollMs));
        // Namespace travels as query params, matching the runs routes
        // (?projectId=&env=); the server defaults to default/prod when absent.
        if (namespace !== undefined) {
          query.set('projectId', namespace.projectId);
          query.set('env', namespace.env);
        }
        let res: WaitResult;
        try {
          res = await http.request<WaitResult>(
            `/runs/${encodeURIComponent(runId)}/result?${query}`,
            // Give the request headroom over the server-side wait it asked for.
            { timeoutMs: slice + 10_000 },
          );
        } catch (err) {
          // Terminal for us: budget spent, or an error retrying cannot fix.
          if (!isRetriable(err) || Date.now() >= deadline) throw err;
          // Clamp the backoff to the remaining budget — never overshoot the
          // caller's deadline, and skip the sleep entirely when nothing is
          // left.
          const sleepMs = Math.min(jitter(backoffMs), deadline - Date.now());
          if (sleepMs > 0) await sleep(sleepMs);
          backoffMs = Math.min(backoffMs * 2, 2000);
          continue;
        }
        // A poll that got a response (terminal or not) resets the backoff.
        backoffMs = 200;
        if (TERMINAL.includes(res.status) || Date.now() >= deadline) return res;
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
