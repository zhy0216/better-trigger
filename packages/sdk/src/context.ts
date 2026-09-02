/* =============================================================================
   better-trigger — run context (RunCtx) shape + the AsyncLocalStorage that
   carries the active replay executor across user code.

   The executor itself lives in @better-trigger/worker (it needs the kernel and
   therefore Postgres); this package only declares the contract it fills. That
   is the whole seam between "define + trigger tasks" (this package, HTTP only)
   and "execute tasks" (the worker daemon).
   ============================================================================= */
import type {
  Namespace,
  ReplayMode,
  RetryPolicy,
  TaskRunResult,
  TriggerItem,
  TriggerOptions,
} from '@better-trigger/core';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { registry } from './registry';

/** Per-step options. */
export interface StepOptions {
  /** Step-level retry policy; overrides the task-level policy for this step. */
  retry?: RetryPolicy;
}

/**
 * Options a durable in-run triggerAndWait accepts: the namespace pair is dropped
 * (a child run always inherits the parent's scope, so env/projectId were warned-
 * and-stripped at runtime), and `idempotencyKey` is dropped (the kernel refuses
 * it with bad_request, which the executor treats as non-retryable and fails the
 * whole parent run). Both used to typecheck and then bite at run time
 * (01-core-sdk T4); the runtime strip/warn stays on as depth defense.
 */
export type DurableTriggerOptions = Omit<
  TriggerOptions,
  'idempotencyKey' | 'env' | 'projectId'
>;

/** Run metadata exposed to user code via ctx.run. */
export interface RunInfo {
  /** Run id. */
  id: string;
  /** Task id. */
  taskId: string;
  /** Current attempt (1-based). */
  attempt: number;
  /** Max attempts locked at trigger time. */
  maxAttempts: number;
  /** Environment scope. */
  env: string;
}

/** Structured logger surface. The 2nd arg is arbitrary JSON-serializable data. */
export interface RunLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/**
 * Why `ctx.signal` aborted:
 *   - 'canceled'       — the run was canceled (dashboard / API); its output is
 *                        already discarded, so stop paying for it.
 *   - 'shutting_down'  — the worker is draining; this attempt is handed back and
 *                        replayed by whoever picks the run up next.
 *   - 'lease_lost'     — this claim's lease expired, another worker may already
 *                        own the run; nothing this attempt writes will be
 *                        accepted (see 01-correctness.md C2).
 */
export type RunAbortReason = 'canceled' | 'shutting_down' | 'lease_lost';

/**
 * The value in `ctx.signal.reason` once the run is aborted. Deliberately an
 * Error: `fetch(url, { signal })` rejects with the reason verbatim, so user code
 * gets a throwable with a message rather than a bare string.
 *
 * Distinct from core's `AbortError` — that one is thrown BY user code to fail a
 * run without retries; this one is handed TO user code to stop work in flight.
 */
export class RunAbortedError extends Error {
  readonly isBetterTriggerRunAborted = true;
  constructor(readonly reason: RunAbortReason) {
    super(`run aborted: ${reason}`);
    this.name = 'RunAbortedError';
  }
}

/** Brand check (survives duplicate copies of this package, like isAbortError). */
export function isRunAborted(err: unknown): err is RunAbortedError {
  return (
    err instanceof RunAbortedError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as Record<string, unknown>).isBetterTriggerRunAborted === true)
  );
}

/** Wait primitives. */
export interface RunWait {
  /** Suspend the run for a duration ("24h", "10m", 5000ms). */
  for(duration: string | number): Promise<void>;
  /** Suspend the run until an absolute date. */
  until(date: Date): Promise<void>;
}

/**
 * The context object passed to a task's run() function: durable primitives,
 * the wait helpers, logger, signal and run metadata.
 */
export interface RunCtx {
  /**
   * Run a durable step. The result is memoized: on replay the cached output is
   * returned without re-executing `fn`. Throwing inside `fn` triggers retries
   * per the effective retry policy (step opts ?? task ?? default).
   */
  step<T>(label: string, fn: () => T | Promise<T>, opts?: StepOptions): Promise<T>;
  /**
   * Trigger a child run by RAW task id and durably wait for it to finish — the
   * string-id form, distinct from `handle.triggerAndWait(payload)` which always
   * triggers the handle's own task. The escape hatch for dynamic child ids: an
   * unregistered id (a typo) fails the call with AbortError instead of creating
   * a child run nobody claims and stranding the parent waiting forever.
   *
   * `options` excludes idempotencyKey/env/projectId — see DurableTriggerOptions:
   * a durable child inherits the parent's namespace and the kernel rejects an
   * idempotency key here (01-core-sdk T4).
   */
  triggerAndWait<TOutput>(
    taskId: string,
    payload: unknown,
    options?: DurableTriggerOptions,
  ): Promise<TaskRunResult<TOutput>>;
  /** Wait primitives (wait.for / wait.until). */
  wait: RunWait;
  /** Structured logger; entries are buffered and shipped to the server. */
  logger: RunLogger;
  /** Deterministic now() — memoized, replays the first recorded timestamp. */
  now(): Promise<Date>;
  /** Deterministic random() — memoized number in [0, 1). */
  random(): Promise<number>;
  /** Deterministic uuid() — memoized v4 string. */
  uuid(): Promise<string>;
  /** Run metadata. */
  run: RunInfo;
  /**
   * Aborted when this attempt's work becomes worthless: the run was canceled,
   * the worker started shutting down, or the claim's lease was lost. Pass it to
   * `fetch(url, { signal: ctx.signal })` / any SDK that takes one so a long call
   * (an LLM request, a tool call) is cut off instead of running to completion
   * for an output nobody will read. `ctx.signal.reason` is a `RunAbortedError`
   * whose `.reason` says which of the three happened.
   *
   * Cancellation is still enforced at durable-primitive boundaries regardless
   * (see the executor's checkCanceled): ignoring this signal is safe, honoring
   * it is just faster. One signal per execution — a replayed run gets its own,
   * and memoized steps that never re-run simply never observe it.
   */
  signal: AbortSignal;
}

/** Re-export for convenience at the public surface. */
export type { TaskRunResult, TriggerOptions };

/* ---------------------------------------------------------------------------
 * The executor contract (implemented by @better-trigger/worker)
 * ------------------------------------------------------------------------- */

/**
 * The slice of the replay executor a TaskHandle calls when it is invoked from
 * inside a run — the two paths that must become durable steps rather than
 * plain HTTP triggers.
 */
export interface RunExecutor {
  /** Durable batch-trigger step; returns the created child run ids. */
  durableBatchTrigger(items: TriggerItem[], label: string): Promise<string[]>;
  /** Durable trigger + suspend until the child reaches a terminal state. */
  triggerAndWait<TOutput>(
    taskId: string,
    payload: unknown,
    label: string,
    options?: TriggerOptions,
  ): Promise<TaskRunResult<TOutput>>;
  /**
   * The namespace the run this executor drives lives in. Handles minted inside
   * the run (durable trigger / batchTrigger) carry it, so their result()
   * polling resolves in the same namespace the child run was created in (C2).
   */
  readonly namespace: Namespace;
}

/** The minimal shape of a task definition the executor consumes. */
export interface ExecutorTask {
  id: string;
  retry?: RetryPolicy;
  /** Replay strictness for snapshot/call-site mismatches. Default 'lenient'. */
  replay?: ReplayMode;
  run: (payload: any, ctx: RunCtx) => unknown | Promise<unknown>;
  /** Validate/parse the raw payload; throws SchemaValidationError on bad input. */
  validate?: (payload: unknown) => Promise<unknown> | unknown;
}

/** The AsyncLocalStorage holding the executor for the currently running task
 *  fn. Process-wide (see ./registry) so it survives duplicate package copies.
 *  Read at access time (a function, not a snapshot) so a daemon that populates
 *  it late (p1-16: async node:async_hooks load on plain Node ESM < 22.3) is
 *  visible to currentExecutor(). May be undefined on platforms without
 *  node:async_hooks — there is no in-flight task there. */
export function executorStorage(): AsyncLocalStorage<RunExecutor> | undefined {
  return registry.executorStorage;
}

/** Returns the active executor if called inside a running task, else undefined. */
export function currentExecutor(): RunExecutor | undefined {
  return executorStorage()?.getStore();
}
