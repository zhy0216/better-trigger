/* =============================================================================
   @better-trigger/worker/embedded — run the worker inside an existing Node/Bun
   process, without opening a port or supervising a separate daemon.

   This is a second HOST for the same runtime, not a second execution model:
   Postgres kernel, leases/fencing, replay executor, orchestrator loops, Hono
   routes and the public BetterTrigger HTTP client are all reused unchanged.
   The client talks to Hono through an in-process fetch adapter, so the wire
   semantics (validation, error mapping, long-polling) still have one owner.

   One embedded runtime may be active per process. Task ctx detection and
   RunHandle.result() are process-wide registry concerns; allowing two runtimes
   backed by different databases would make an in-run handle ambiguous.
   ============================================================================= */
import type { Pool } from 'pg';
import {
  assertNamespace,
  DEFAULT_NAMESPACE,
  type Namespace,
  type RetryPolicy,
} from '@better-trigger/core';
import {
  createPool,
  DEFAULT_DATABASE_URL,
  migrate as runMigrations,
  type PoolOptions,
} from '@better-trigger/db';
import {
  createKernel,
  type Kernel,
  type OrchestratorOptions,
} from '@better-trigger/kernel';
import {
  betterTrigger,
  type BetterTrigger,
  type TaskHandle,
} from 'better-trigger';
import {
  executorStorage,
  getDefaultInstance,
  getResultResolver,
  loadExecutorStorageAsync,
  setDefaultInstance,
  setExecutorStorage,
  setResultResolver,
  type RunResultResolver,
} from 'better-trigger/internal';
import { createApp } from './app';
import {
  createNotifyCounters,
  type WorkerLogger,
} from './observability';
import {
  createNotifyListener,
  createWakeSignal,
  type NotifyListener,
  type NotifyPayload,
} from './notify';
import { derivePoolConfig } from './pool-config';
import { startWorkerRuntime, type WorkerHandle } from './runtime';
import { createWaiterRegistry, type WaiterRegistry } from './waiters';

const EMBEDDED_URL = 'http://better-trigger.internal';
const SLOT_KEY = Symbol.for('better-trigger.worker.embedded.v1');

interface EmbeddedSlot {
  active: symbol | null;
}

type GlobalWithEmbeddedSlot = typeof globalThis & { [SLOT_KEY]?: EmbeddedSlot };

const globalWithSlot = globalThis as GlobalWithEmbeddedSlot;
const embeddedSlot = (globalWithSlot[SLOT_KEY] ??= { active: null });

export interface EmbeddedRuntimeOptions {
  /** Task definitions executed by this process. At least one is required. */
  tasks: readonly TaskHandle<any, any>[];

  /**
   * PostgreSQL connection string. Used to create the pool when `pool` is not
   * supplied, and by the optional LISTEN/NOTIFY fast path. With an injected
   * pool it may be omitted; correctness then falls back to polling.
   */
  databaseUrl?: string;
  /** Existing application-owned pool. It is left open on stop by default. */
  pool?: Pool;
  /** Pool settings when the runtime creates its own pool. */
  poolOptions?: PoolOptions;
  /** Apply better_trigger migrations before starting. Default true. */
  migrate?: boolean;
  /**
   * Close the pool on stop. Defaults to true for a runtime-created pool and
   * false for an injected pool.
   */
  closePoolOnStop?: boolean;

  /** Number of concurrent claim/execution slots. Default 5. */
  concurrency?: number;
  /** Friendly name recorded in the workers table. */
  name?: string;
  /** Lease duration per claim. Default 60s. */
  leaseMs?: number;
  /** Claim only runs stamped with this process's task versions. */
  pinCodeVersion?: boolean;
  /** Maximum replay ledger length; 0 means unlimited. */
  maxSteps?: number;
  /** Namespaces served by this runtime. Default default/prod. */
  namespaces?: readonly Namespace[];
  /** Default retry inherited by tasks that define none. */
  defaultRetry?: RetryPolicy;
  /** Orchestrator intervals / retention knobs; namespaces come from above. */
  orchestrator?: Omit<OrchestratorOptions, 'namespaces'>;

  /** Enable the dedicated PostgreSQL LISTEN connection. Default when a
   * connection string is available; polling remains the correctness path. */
  notifications?: boolean;
  /** Shared logger for pool, kernel and worker best-effort paths. */
  logger?: WorkerLogger;

  /** Bearer key sent through the in-process HTTP client, when auth env vars
   * configure the shared Hono middleware. Defaults like betterTrigger(). */
  apiKey?: string;
  /** Per-request client timeout. Default 30s. */
  timeoutMs?: number;
  /** Make runtime.client the TaskHandle process default. Default true. */
  setDefault?: boolean;
}

export interface EmbeddedRuntime {
  /** The normal BetterTrigger client, backed by an in-process fetch adapter. */
  readonly client: BetterTrigger;
  /** Hono application used by the client; may also be mounted by the host. */
  readonly app: ReturnType<typeof createApp>;
  /** Fetch-compatible adapter that dispatches directly to `app`. */
  readonly fetch: typeof globalThis.fetch;
  /** Worker runtime handle and live counters. */
  readonly worker: WorkerHandle;
  /** Pool used by the kernel (owned according to closePoolOnStop). */
  readonly pool: Pool;
  /** Drain tasks, release claims, stop background loops/listeners and clean up. */
  stop(): Promise<void>;
}

function normalizeTasks(tasks: readonly TaskHandle<any, any>[]): Array<TaskHandle<any, any>> {
  if (tasks.length === 0) {
    throw new Error('createEmbeddedRuntime requires at least one task');
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || task.id.length === 0) {
      throw new Error('createEmbeddedRuntime tasks must be TaskHandle values with a non-empty id');
    }
    if (seen.has(task.id)) {
      throw new Error(`createEmbeddedRuntime received duplicate task id "${task.id}"`);
    }
    seen.add(task.id);
  }
  return [...tasks];
}

function normalizeNamespaces(input: readonly Namespace[] | undefined): Namespace[] {
  const namespaces = input === undefined ? [DEFAULT_NAMESPACE] : [...input];
  if (namespaces.length === 0) {
    throw new Error('createEmbeddedRuntime namespaces must not be empty');
  }
  const seen = new Set<string>();
  const result: Namespace[] = [];
  for (const namespace of namespaces) {
    assertNamespace(namespace);
    const key = `${namespace.projectId}:${namespace.env}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...namespace });
  }
  return result;
}

function acquireSlot(): symbol {
  if (embeddedSlot.active !== null) {
    throw new Error(
      'only one createEmbeddedRuntime instance may be active in a process; stop the existing runtime first',
    );
  }
  const token = Symbol('embedded-runtime');
  embeddedSlot.active = token;
  return token;
}

function releaseSlot(token: symbol): void {
  if (embeddedSlot.active === token) embeddedSlot.active = null;
}

function stoppedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'embedded_runtime_stopping', message: 'embedded runtime is stopping' },
    }),
    { status: 503, headers: { 'content-type': 'application/json; charset=UTF-8' } },
  );
}

/**
 * Start better-trigger inside the calling Node/Bun process. No TCP listener is
 * opened: `runtime.client` dispatches to the existing Hono API in memory.
 */
export async function createEmbeddedRuntime(
  options: EmbeddedRuntimeOptions,
): Promise<EmbeddedRuntime> {
  const tasks = normalizeTasks(options.tasks);
  const namespaces = normalizeNamespaces(options.namespaces);
  const concurrency = options.concurrency ?? 5;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`createEmbeddedRuntime concurrency must be a positive integer, got ${concurrency}`);
  }
  if (options.pool && options.poolOptions) {
    throw new Error('createEmbeddedRuntime poolOptions cannot be used with an injected pool');
  }

  const slotToken = acquireSlot();
  const logger = options.logger ?? console;
  const ownsPool = options.pool === undefined;
  const connectionString = options.databaseUrl ??
    (ownsPool ? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL : undefined);
  if (options.notifications === true && connectionString === undefined) {
    releaseSlot(slotToken);
    throw new Error(
      'createEmbeddedRuntime notifications require databaseUrl when using an injected pool',
    );
  }

  let pool: Pool | null = null;
  let worker: WorkerHandle | null = null;
  let waiters: WaiterRegistry | null = null;
  let notifyListener: NotifyListener | null = null;
  let previousDefault: BetterTrigger | null = null;
  let previousResolver: RunResultResolver | null = null;
  let client: BetterTrigger | null = null;
  let resolver: RunResultResolver | null = null;
  let registryInstalled = false;
  let stopping = false;

  const closePoolOnStop = options.closePoolOnStop ?? ownsPool;

  const restoreRegistry = (): void => {
    if (!registryInstalled) return;
    if (resolver !== null && getResultResolver() === resolver) {
      setResultResolver(previousResolver);
    }
    if (options.setDefault !== false && client !== null && getDefaultInstance() === client) {
      setDefaultInstance(previousDefault);
    }
    registryInstalled = false;
  };

  const cleanup = async (includeWorker: boolean): Promise<unknown[]> => {
    const errors: unknown[] = [];
    stopping = true;
    if (includeWorker && worker) {
      try {
        await worker.stop();
      } catch (err) {
        errors.push(err);
      }
    }
    if (notifyListener) {
      try {
        await notifyListener.stop();
      } catch (err) {
        errors.push(err);
      }
    }
    waiters?.stop();
    restoreRegistry();
    if (pool && closePoolOnStop) {
      try {
        await pool.end();
      } catch (err) {
        errors.push(err);
      }
    }
    releaseSlot(slotToken);
    return errors;
  };

  try {
    pool = options.pool ?? createPool(
      connectionString!,
      logger,
      { ...derivePoolConfig(concurrency, process.env), ...options.poolOptions },
    );
    if (options.migrate !== false) await runMigrations(pool);

    const kernel: Kernel = createKernel({ pool, logger });
    const notifyCounters = createNotifyCounters();
    const wake = createWakeSignal();
    waiters = createWaiterRegistry({ pool, counters: notifyCounters });

    if (connectionString !== undefined && options.notifications !== false) {
      notifyListener = createNotifyListener({
        connectionString,
        logger,
        counters: notifyCounters,
        onNotify: (payload: NotifyPayload) => {
          if (payload.type === 'work') {
            notifyCounters.claimWakes += 1;
            wake.emit();
            return;
          }
          const serving = namespaces.some(
            (namespace) =>
              namespace.projectId === payload.projectId && namespace.env === payload.env,
          );
          if (serving) void waiters?.resolve(payload.runId);
        },
      });
    }

    if (!executorStorage()) {
      const storageCtor = await loadExecutorStorageAsync();
      if (!storageCtor) {
        throw new Error(
          'createEmbeddedRuntime requires node:async_hooks; run it under Node.js or Bun',
        );
      }
      setExecutorStorage(new storageCtor());
    }

    // Install result resolution BEFORE claim loops start. A database may
    // already contain queued work, and the first claimed task is allowed to
    // create a durable child then call handle.result() immediately.
    previousResolver = getResultResolver();
    resolver = {
      waitForResult: (runId, namespace, waitOptions) =>
        waiters!.register(runId, namespace ?? DEFAULT_NAMESPACE, waitOptions),
    };
    setResultResolver(resolver);
    registryInstalled = true;

    worker = await startWorkerRuntime(
      {
        kernel,
        logger,
        wake,
        defaultRetry: options.defaultRetry,
        orchestrator: {
          ...options.orchestrator,
          stranded: options.orchestrator?.stranded ?? options.pinCodeVersion ?? false,
        },
      },
      {
        tasks,
        concurrency,
        name: options.name,
        leaseMs: options.leaseMs,
        pinCodeVersion: options.pinCodeVersion,
        maxSteps: options.maxSteps,
        namespaces,
      },
    );

    const app = createApp({
      kernel,
      pool,
      waiters,
      metrics: {
        worker,
        orchestrator: worker.orchestratorCounters,
        notify: notifyCounters,
      },
      namespaces,
    });

    const inProcessFetch: typeof globalThis.fetch = async (input, init) => {
      if (stopping) return stoppedResponse();
      return app.fetch(new Request(input, init));
    };

    previousDefault = getDefaultInstance();
    client = betterTrigger({
      url: EMBEDDED_URL,
      fetch: inProcessFetch,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
    });
    if (options.setDefault === false) {
      // betterTrigger() installs itself only when no default existed. Undo that
      // implicit install for callers that requested an explicit-only client.
      if (getDefaultInstance() === client) setDefaultInstance(previousDefault);
    } else {
      setDefaultInstance(client);
    }

    let stopPromise: Promise<void> | null = null;
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const errors = await cleanup(true);
        if (errors.length > 0) {
          throw new AggregateError(errors, 'embedded runtime shutdown failed');
        }
      })();
      return stopPromise;
    };

    return { client, app, fetch: inProcessFetch, worker, pool, stop };
  } catch (err) {
    const cleanupErrors = await cleanup(worker !== null);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [err, ...cleanupErrors],
        'embedded runtime startup failed',
        { cause: err },
      );
    }
    throw err;
  }
}
