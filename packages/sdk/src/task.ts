/* =============================================================================
   better-trigger — task() definition + TaskHandle.

   Two signatures:
     task(id, fn)        — minimal; payload type inferred from fn's parameter.
     task(config)        — full; payload type inferred from `schema` if present,
                           otherwise from the `run` function's first parameter.

   A TaskHandle exposes trigger / batchTrigger / triggerAndWait. When called
   inside a running task (detected via AsyncLocalStorage — i.e. inside the
   worker daemon) these become durable steps; outside, they go over HTTP
   through the default betterTrigger() instance.
   ============================================================================= */
import type {
  CronConfig,
  ReplayMode,
  RetryPolicy,
  TaskManifest,
  TaskRunResult,
  TriggerOptions,
} from '@better-trigger/core';
import { currentExecutor, type ExecutorTask, type RunCtx } from './context';
import { makeRunHandle, requireDefaultInstance, type RunHandle } from './instance';
import { isSchema, validateSchema, type AnySchema, type InferSchema } from './schema';

/** Concurrency config: a numeric limit plus an optional per-payload key fn. */
export interface ConcurrencyConfig<TPayload> {
  /** Max concurrent running runs per key. */
  limit?: number;
  /** Derives the concurrency key from the payload (evaluated SDK-side on trigger). */
  key?: (payload: TPayload) => string;
}

/** A cron may be a raw 5-field string or a { pattern, timezone } object. */
export type CronInput = string | CronConfig;

/** Per-item options for batchTrigger. The namespace (env/projectId) is
 *  deliberately NOT here: a batch is all-or-nothing in ONE namespace (the
 *  batch-level `options` of batchTrigger), so a per-item env/projectId used to
 *  typecheck and then be silently dropped — a staging intent creating prod
 *  runs. Now it is a compile error instead (p1-15). */
export type BatchItemOptions = Omit<TriggerOptions, 'env' | 'projectId'>;

/** Per-item payload for batchTrigger. */
export interface BatchItem<TPayload> {
  payload: TPayload;
  options?: BatchItemOptions;
}

/** Warn when a durable (in-run) trigger/batchTrigger is given an explicit
 *  env/projectId: children always inherit the parent's namespace, so the value
 *  is dropped. A compile error where the type can be narrowed (per-item batch
 *  options), a loud warn where the shared TriggerOptions type cannot. */
function warnIgnoredNamespace(options?: TriggerOptions): void {
  if (options && (options.env !== undefined || options.projectId !== undefined)) {
    console.warn(
      `better-trigger: a durable trigger inside a run cannot change the namespace — ` +
        `env/projectId on this call is ignored; the child run inherits the parent's ` +
        `namespace. (p1-15)`,
    );
  }
}

/** Drop env/projectId from options headed into a durable step. Children always
 *  inherit the parent's namespace, so the pair cannot be honoured — and it must
 *  not ride along either, or the same call site with a different env would
 *  fingerprint a different durable step row (replay drift for a value that is
 *  ignored anyway, see p1-15). */
function stripIgnoredNamespace(options?: TriggerOptions): TriggerOptions | undefined {
  if (!options) return options;
  if (options.env === undefined && options.projectId === undefined) return options;
  const { env: _ignoredEnv, projectId: _ignoredProjectId, ...rest } = options;
  return rest;
}

/** The object returned by task(); the user's handle to a task. */
export interface TaskHandle<TPayload, TOutput> {
  /** Stable task id. */
  readonly id: string;
  /** Internal task definition (consumed by the worker / executor). */
  readonly __definition: ResolvedTaskDefinition<TPayload, TOutput>;

  /**
   * Trigger one run. Outside a task → the default betterTrigger() instance.
   * Inside a task → durable batch-trigger step (a 1-item batch). Returns a
   * handle with the run id.
   */
  trigger(payload: TPayload, options?: TriggerOptions): Promise<RunHandle>;

  /**
   * Trigger many runs. Outside a task → the default betterTrigger() instance,
   * where `options` (env/projectId) names the namespace the WHOLE batch runs
   * in. Inside a task → durable batch-trigger step; the children always inherit
   * the parent's namespace, so `options` carries no namespace there (a set
   * env/projectId is warned and ignored). Returns one handle per item, in order.
   */
  batchTrigger(items: Array<BatchItem<TPayload>>, options?: TriggerOptions): Promise<RunHandle[]>;

  /**
   * Trigger a child run and durably wait for it. MUST be called inside a task.
   * Never throws on child failure — inspect `result.ok` / use unwrapResult().
   */
  triggerAndWait(payload: TPayload, options?: TriggerOptions): Promise<TaskRunResult<TOutput>>;
}

/** Normalized internal definition. */
export interface ResolvedTaskDefinition<TPayload, TOutput> {
  id: string;
  name?: string;
  description?: string;
  filePath?: string;
  cron?: CronConfig;
  retry?: RetryPolicy;
  replay?: ReplayMode;
  concurrency?: ConcurrencyConfig<TPayload>;
  schema?: AnySchema<TPayload>;
  run: (payload: TPayload, ctx: RunCtx) => TOutput | Promise<TOutput>;
}

/* ---- task(config) overload types ---------------------------------------- */

/** Config form keyed off a schema (payload inferred from the schema). */
interface TaskConfigWithSchema<TSchema extends AnySchema, TOutput> {
  id: string;
  name?: string;
  description?: string;
  filePath?: string;
  cron?: CronInput;
  retry?: RetryPolicy;
  /**
   * Replay strictness (default 'lenient'). 'strict' fails the run instead of
   * feeding a cached step row to a call site whose kind/label no longer match —
   * use it on tasks whose runs can outlive a deploy (long ctx.wait).
   */
  replay?: ReplayMode;
  schema: TSchema;
  concurrency?: ConcurrencyConfig<InferSchema<TSchema>>;
  run: (payload: InferSchema<TSchema>, ctx: RunCtx) => TOutput | Promise<TOutput>;
}

/** Config form without a schema (payload inferred from run's parameter). */
interface TaskConfigNoSchema<TPayload, TOutput> {
  id: string;
  name?: string;
  description?: string;
  filePath?: string;
  cron?: CronInput;
  retry?: RetryPolicy;
  /** Replay strictness (default 'lenient'). See TaskConfigWithSchema.replay. */
  replay?: ReplayMode;
  schema?: undefined;
  concurrency?: ConcurrencyConfig<TPayload>;
  run: (payload: TPayload, ctx: RunCtx) => TOutput | Promise<TOutput>;
}

/* ---- overloads ---------------------------------------------------------- */

/** task(id, fn) — payload from fn parameter, ctx is optional. */
export function task<TPayload, TOutput>(
  id: string,
  fn: (payload: TPayload, ctx: RunCtx) => TOutput | Promise<TOutput>,
): TaskHandle<TPayload, Awaited<TOutput>>;

/** task({ schema, run }) — payload inferred from the schema. */
export function task<TSchema extends AnySchema, TOutput>(
  config: TaskConfigWithSchema<TSchema, TOutput>,
): TaskHandle<InferSchema<TSchema>, Awaited<TOutput>>;

/** task({ run }) — payload inferred from run's first parameter. */
export function task<TPayload, TOutput>(
  config: TaskConfigNoSchema<TPayload, TOutput>,
): TaskHandle<TPayload, Awaited<TOutput>>;

export function task(
  idOrConfig: string | object,
  maybeFn?: (payload: any, ctx: RunCtx) => unknown,
): TaskHandle<any, any> {
  const def = normalizeDefinition(idOrConfig as string | Record<string, unknown>, maybeFn);
  return makeHandle(def);
}

/* ---- definition normalization ------------------------------------------- */

function normalizeDefinition(
  idOrConfig: string | Record<string, unknown>,
  maybeFn?: (payload: any, ctx: RunCtx) => unknown,
): ResolvedTaskDefinition<any, any> {
  if (typeof idOrConfig === 'string') {
    if (typeof maybeFn !== 'function') {
      throw new Error(`task("${idOrConfig}", fn): second argument must be a function`);
    }
    return { id: idOrConfig, run: maybeFn };
  }

  const config = idOrConfig as Record<string, unknown>;
  const id = config.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('task(config): "id" is required and must be a non-empty string');
  }
  if (typeof config.run !== 'function') {
    throw new Error(`task("${id}"): "run" must be a function`);
  }
  if (config.schema !== undefined && !isSchema(config.schema)) {
    throw new Error(
      `task("${id}"): "schema" must implement Standard Schema (~standard) or expose parse/safeParse`,
    );
  }
  if (
    config.replay !== undefined &&
    config.replay !== 'lenient' &&
    config.replay !== 'strict'
  ) {
    throw new Error(`task("${id}"): "replay" must be 'lenient' or 'strict'`);
  }

  return {
    id,
    name: config.name as string | undefined,
    description: config.description as string | undefined,
    filePath: config.filePath as string | undefined,
    cron: normalizeCron(config.cron as CronInput | undefined),
    retry: config.retry as RetryPolicy | undefined,
    replay: config.replay as ReplayMode | undefined,
    concurrency: config.concurrency as ConcurrencyConfig<any> | undefined,
    schema: config.schema as AnySchema<any> | undefined,
    run: config.run as (payload: any, ctx: RunCtx) => unknown,
  };
}

/** Normalize a cron string/object into a { pattern, timezone } object. */
export function normalizeCron(cron: CronInput | undefined): CronConfig | undefined {
  if (cron === undefined) return undefined;
  if (typeof cron === 'string') return { pattern: cron };
  return { pattern: cron.pattern, timezone: cron.timezone };
}

/* ---- handle construction ------------------------------------------------ */

function makeHandle<TPayload, TOutput>(
  def: ResolvedTaskDefinition<TPayload, TOutput>,
): TaskHandle<TPayload, TOutput> {
  const concurrencyKeyFor = (payload: TPayload): string | undefined => {
    const c = def.concurrency;
    if (!c?.key) return undefined;
    return c.key(payload);
  };

  /** Merge a derived concurrency key into options (explicit option wins). */
  const withConcurrencyKey = (
    payload: TPayload,
    options?: TriggerOptions,
  ): TriggerOptions | undefined => {
    const key = options?.concurrencyKey ?? concurrencyKeyFor(payload);
    if (key === undefined) return options;
    return { ...options, concurrencyKey: key };
  };

  const handle: TaskHandle<TPayload, TOutput> = {
    id: def.id,
    __definition: def,

    async trigger(payload, options) {
      const opts = withConcurrencyKey(payload, options);
      const executor = currentExecutor();
      if (executor) {
        // Durable: a 1-item batch-trigger step. Label = task id for traceability.
        // The child inherits the parent's namespace, so an explicit env/projectId
        // cannot be honoured — warn instead of silently dropping it (p1-15).
        warnIgnoredNamespace(options);
        const runIds = await executor.durableBatchTrigger(
          [{ taskId: def.id, payload, options: stripIgnoredNamespace(opts) }],
          `trigger:${def.id}`,
        );
        // The child lives in the parent's namespace — carry it on the handle so
        // result() polls the same scope it was created in.
        return makeRunHandle(runIds[0], undefined, undefined, executor.namespace);
      }
      return requireDefaultInstance().trigger(def.id, payload, opts);
    },

    async batchTrigger(items, options) {
      const executor = currentExecutor();
      const triggerItems = items.map((it) => ({
        taskId: def.id,
        payload: it.payload,
        options: withConcurrencyKey(it.payload, it.options),
      }));
      if (executor) {
        // Children always inherit the parent's namespace (C2); a batch-level
        // env/projectId cannot be honoured in-run — say so instead of silently
        // dropping a staging intent.
        warnIgnoredNamespace(options);
        const runIds = await executor.durableBatchTrigger(
          triggerItems,
          `batchTrigger:${def.id}`,
        );
        return runIds.map((id) => makeRunHandle(id, undefined, undefined, executor.namespace));
      }
      return requireDefaultInstance().batchTrigger(triggerItems, options);
    },

    async triggerAndWait(payload, options) {
      const executor = currentExecutor();
      if (!executor) {
        throw new Error(
          `triggerAndWait("${def.id}") must be called inside a running task (use trigger() from app code)`,
        );
      }
      const opts = withConcurrencyKey(payload, options);
      warnIgnoredNamespace(options);
      return executor.triggerAndWait<TOutput>(
        def.id,
        payload,
        `triggerAndWait:${def.id}`,
        stripIgnoredNamespace(opts),
      );
    },
  };

  return handle;
}

/* ---- adapters for the executor + worker --------------------------------- */

/** Convert a task definition into the minimal shape the executor consumes. */
export function toExecutorTask(
  def: ResolvedTaskDefinition<any, any>,
): ExecutorTask {
  return {
    id: def.id,
    retry: def.retry,
    replay: def.replay,
    run: def.run,
    validate: def.schema
      ? (payload: unknown) => validateSchema(def.schema!, payload)
      : undefined,
  };
}

/** Build the registration manifest entry for a task. */
export function toManifest(def: ResolvedTaskDefinition<any, any>): TaskManifest {
  const manifest: TaskManifest = { id: def.id };
  if (def.name !== undefined) manifest.name = def.name;
  if (def.filePath !== undefined) manifest.filePath = def.filePath;
  if (def.description !== undefined) manifest.description = def.description;
  if (def.cron !== undefined) manifest.cron = def.cron;
  if (def.retry !== undefined) manifest.retry = def.retry;
  if (def.concurrency?.limit !== undefined) {
    manifest.concurrencyLimit = def.concurrency.limit;
  }
  return manifest;
}

/** Helper that unwraps a TaskRunResult, throwing on child failure. */
export function unwrapResult<TOutput>(result: TaskRunResult<TOutput>): TOutput {
  if (!result.ok) {
    const err = new Error(result.error?.message ?? `child run ${result.id} failed`);
    if (result.error?.name) err.name = result.error.name;
    if (result.error?.stack) err.stack = result.error.stack;
    throw err;
  }
  return result.output as TOutput;
}
