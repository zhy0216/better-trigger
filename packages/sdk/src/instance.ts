/* =============================================================================
   better-trigger — betterTrigger() instance facade (embedded runtime).
   One instance = one Postgres pool + one kernel. The facade owns readiness
   (memoized auto-migrations from @better-trigger/db), exposes the client API
   (trigger / batchTrigger / cancel / retry / reads) by delegating to the
   kernel, and starts the embedded worker (claim slots + orchestrator loops)
   via start(). The first instance created becomes the module-level default
   that instance-free TaskHandles route through when triggered outside a run.
   ============================================================================= */
import type { Pool } from 'pg';
import {
  createKernel,
  type OrchestratorOptions,
  type RetryPolicy,
  type RunDetailResult,
  type RunRecord,
  type TriggerItem,
  type TriggerOptions,
  type WaitForResultOptions,
  type WaitResult,
} from '@better-trigger/core';
import { createPool, migrate } from '@better-trigger/db';
import type { TaskHandle } from './task';
import { startWorkerRuntime, type StartOptions, type WorkerHandle } from './worker';

/** Returned by trigger / batchTrigger: the run id plus a result() poller. */
export interface RunHandle {
  /** Run id. */
  id: string;
  /** Poll the run to a terminal state (timeout → latest non-terminal status). */
  result(opts?: WaitForResultOptions): Promise<WaitResult>;
}

export interface BetterTriggerOptions {
  /**
   * A pg Pool (caller-owned, never ended by the instance) or a
   * { connectionString } (the instance creates and owns the pool, ending it
   * on stop). Detection is duck-typed on the presence of query().
   */
  database: Pool | { connectionString: string };
  /** 'auto' (default) applies @better-trigger/db migrations before first use. */
  migrations?: 'auto' | 'manual';
  /** Instance-level defaults applied to tasks that do not define their own. */
  defaults?: { retry?: RetryPolicy };
  /** Orchestrator loop intervals (test knobs; defaults 1s / 1s / 10s). */
  orchestrator?: OrchestratorOptions;
  /** Plugin interceptors — reserved; only an empty array is accepted in P1. */
  plugins?: unknown[];
}

export interface BetterTrigger {
  /** Start the embedded worker (claim slots + orchestrator) on this instance. */
  start(opts: StartOptions): Promise<WorkerHandle>;
  /** Stop the worker (if started) and end the pool when this instance owns it. */
  stop(): Promise<void>;

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
  /** Poll a run to a terminal state (timeout → latest non-terminal status). */
  waitForResult(runId: string, opts?: WaitForResultOptions): Promise<WaitResult>;

  /** Make this instance the module-level default used by TaskHandle triggers. */
  setDefault(): void;
}

/* ---------------------------------------------------------------------------
 * Default-instance registry
 * ------------------------------------------------------------------------- */

/** First betterTrigger() instance, or the last one to call setDefault(). */
let defaultInstance: BetterTrigger | null = null;

/** The default instance instance-free TaskHandles use outside a run. */
export function requireDefaultInstance(): BetterTrigger {
  if (!defaultInstance) {
    throw new Error(
      'No betterTrigger instance registered — call betterTrigger({...}) first',
    );
  }
  return defaultInstance;
}

/**
 * Build a RunHandle. Handles minted by an instance bind result() to it;
 * handles minted inside a run (durable trigger paths) resolve the module
 * default lazily at result() call time.
 */
export function makeRunHandle(id: string, instance?: BetterTrigger): RunHandle {
  return {
    id,
    result: (opts) => (instance ?? requireDefaultInstance()).waitForResult(id, opts),
  };
}

/* ---------------------------------------------------------------------------
 * Factory
 * ------------------------------------------------------------------------- */

/** Duck-typed Pool detection ('query' in x) — no instanceof, so a Pool from a
 *  different pg copy still counts. */
function isPoolLike(db: BetterTriggerOptions['database']): db is Pool {
  return typeof db === 'object' && db !== null && 'query' in db;
}

/**
 * Create a better-trigger instance bound to a Postgres database. Returns
 * synchronously; migrations (when 'auto') run lazily, memoized, before the
 * first operation that touches the database.
 */
export function betterTrigger(options: BetterTriggerOptions): BetterTrigger {
  if (options?.database == null) {
    throw new Error(
      'betterTrigger: "database" is required (a pg Pool or { connectionString })',
    );
  }
  if (options.plugins && options.plugins.length > 0) {
    throw new Error('betterTrigger: plugins are not implemented yet');
  }

  const ownsPool = !isPoolLike(options.database);
  const pool = isPoolLike(options.database)
    ? options.database
    : createPool(options.database.connectionString);
  const kernel = createKernel({ pool });
  const migrations = options.migrations ?? 'auto';

  /** Memoized readiness: auto-migrate once before first use. Success stays
   *  cached; a rejection clears the memo so the next call retries instead of
   *  poisoning the instance after one transient DB error. */
  let ready: Promise<void> | null = null;
  const ensureReady = (): Promise<void> => {
    if (!ready) {
      const attempt = migrations === 'auto' ? migrate(pool) : Promise.resolve();
      ready = attempt;
      attempt.catch(() => {
        if (ready === attempt) ready = null;
      });
    }
    return ready;
  };

  /** Idempotent owned-pool teardown (no-op when the caller owns the pool). */
  let poolEnded: Promise<void> | null = null;
  const endOwnedPool = (): Promise<void> => {
    if (!ownsPool) return Promise.resolve();
    poolEnded ??= pool.end();
    return poolEnded;
  };

  let worker: WorkerHandle | null = null;
  /** Reserved synchronously by start() before any await; held until the worker
   *  fully stops (or startup fails), so concurrent start() calls cannot both
   *  pass the guard and spawn two runtimes. */
  let startPromise: Promise<WorkerHandle> | null = null;
  /** Memoized in-flight stop(), so a concurrent second stop() joins the drain
   *  instead of skipping it and ending the pool mid-flight. */
  let stopPromise: Promise<void> | null = null;

  /** Runs once the worker runtime fully stopped (any stop path — handle.stop,
   *  instance.stop, or a signal): release the start slot so a stopped instance
   *  can start() again on a borrowed pool, then end an owned pool. */
  const onWorkerStopped = async (): Promise<void> => {
    worker = null;
    startPromise = null;
    await endOwnedPool();
  };

  const instance: BetterTrigger = {
    async start(opts) {
      // Reserve the slot before any await (TOCTOU guard); a new lifecycle
      // generation also gets a fresh stop memo so the next stop() really stops.
      if (startPromise) {
        throw new Error('betterTrigger: worker already started on this instance');
      }
      stopPromise = null;
      const starting = (async () => {
        await ensureReady();
        const handle = await startWorkerRuntime(
          {
            kernel,
            orchestrator: options.orchestrator,
            defaultRetry: options.defaults?.retry,
            onStopped: onWorkerStopped,
          },
          opts,
        );
        worker = handle;
        return handle;
      })();
      startPromise = starting;
      try {
        return await starting;
      } catch (err) {
        // Failed startup releases the slot so start() can be retried.
        if (startPromise === starting) startPromise = null;
        throw err;
      }
    },

    async stop() {
      stopPromise ??= (async () => {
        // Join an in-flight start() so its runtime gets stopped, not orphaned
        // on an ended pool (a failed start yields nothing to stop).
        const h = worker ?? (await startPromise?.then((w) => w, () => null)) ?? null;
        worker = null;
        // h.stop() drains in-flight runs, then onWorkerStopped ends an owned
        // pool; idempotent with WorkerHandle.stop() (the runtime memoizes).
        if (h) await h.stop();
        await endOwnedPool();
      })();
      return stopPromise;
    },

    async trigger(taskOrId, payload, options) {
      await ensureReady();
      let taskId: string;
      let opts = options;
      if (typeof taskOrId === 'string') {
        taskId = taskOrId;
      } else {
        // Same concurrency-key derivation as TaskHandle: explicit option wins.
        taskId = taskOrId.id;
        const key =
          options?.concurrencyKey ??
          taskOrId.__definition.concurrency?.key?.(payload);
        if (key !== undefined) opts = { ...options, concurrencyKey: key };
      }
      const created = await kernel.trigger({ taskId, payload, options: opts });
      return makeRunHandle(created.runId, instance);
    },

    async batchTrigger(items) {
      await ensureReady();
      const res = await kernel.batchTrigger(items);
      return res.runIds.map((id) => makeRunHandle(id, instance));
    },

    async cancelRun(runId) {
      await ensureReady();
      await kernel.cancelRun(runId);
    },

    async retryRun(runId) {
      await ensureReady();
      return kernel.retryRun(runId);
    },

    async getRun(runId) {
      await ensureReady();
      return kernel.getRun(runId);
    },

    async getRunDetail(runId) {
      await ensureReady();
      return kernel.getRunDetail(runId);
    },

    async waitForResult(runId, opts) {
      await ensureReady();
      return kernel.waitForResult(runId, opts);
    },

    setDefault() {
      defaultInstance = instance;
    },
  };

  // The first instance becomes the module default (P1: no multi-instance
  // routing; later instances may take over explicitly via setDefault()).
  defaultInstance ??= instance;

  return instance;
}
