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
  RunDetailResult,
  RunRecord,
  RunStatus,
  TriggerItem,
  TriggerOptions,
  WaitForResultOptions,
  WaitResult,
} from '@better-trigger/core';
import { HttpClient, type HttpClientOptions } from './client';
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
  /** Trigger many runs in one all-or-nothing transaction. */
  batchTrigger(items: TriggerItem[]): Promise<RunHandle[]>;
  /** Cancel a non-terminal run (terminal → no-op). */
  cancelRun(runId: string): Promise<void>;
  /** Re-run a failed/canceled run as a NEW run. */
  retryRun(runId: string): Promise<{ runId: string }>;
  /** Full run record. */
  getRun(runId: string): Promise<RunRecord>;
  /** Run + steps + waits + logs (logs capped at 1000). */
  getRunDetail(runId: string): Promise<RunDetailResult>;
  /** Wait for a run to reach a terminal state (timeout → latest status). */
  waitForResult(runId: string, opts?: WaitForResultOptions): Promise<WaitResult>;
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
  waitForResult(runId: string, opts?: WaitForResultOptions): Promise<WaitResult>;
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
 * default instance lazily, at result() call time.
 */
export function makeRunHandle(
  id: string,
  instance?: BetterTrigger,
  idempotent?: boolean,
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
      return target.waitForResult(id, opts);
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
      return makeRunHandle(created.runId, instance, created.idempotent);
    },

    async batchTrigger(items) {
      const res = await http.request<{ runIds: string[] }>('/batch-trigger', {
        method: 'POST',
        body: { items },
      });
      return res.runIds.map((id) => makeRunHandle(id, instance));
    },

    async cancelRun(runId) {
      await http.request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
    },

    retryRun(runId) {
      return http.request<{ runId: string }>(`/runs/${encodeURIComponent(runId)}/retry`, {
        method: 'POST',
      });
    },

    getRun(runId) {
      return http.request<RunRecord>(`/runs/${encodeURIComponent(runId)}/record`);
    },

    getRunDetail(runId) {
      return http.request<RunDetailResult>(`/runs/${encodeURIComponent(runId)}`);
    },

    async waitForResult(runId, opts) {
      const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
      const pollMs = opts?.pollMs;
      for (;;) {
        // Each hop long-polls server-side for at most MAX_LONGPOLL_MS; the
        // remaining budget can be 0, which asks for a single immediate read.
        const slice = Math.max(0, Math.min(deadline - Date.now(), MAX_LONGPOLL_MS));
        const query = new URLSearchParams({ timeoutMs: String(slice) });
        if (pollMs !== undefined) query.set('pollMs', String(pollMs));
        const res = await http.request<WaitResult>(
          `/runs/${encodeURIComponent(runId)}/result?${query}`,
          // Give the request headroom over the server-side wait it asked for.
          { timeoutMs: slice + 10_000 },
        );
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
