/* =============================================================================
   better-trigger — run context (RunCtx) shape + the AsyncLocalStorage that
   carries the active replay executor across user code.

   The executor itself lives in @better-trigger/worker (it needs the kernel and
   therefore Postgres); this package only declares the contract it fills. That
   is the whole seam between "define + trigger tasks" (this package, HTTP only)
   and "execute tasks" (the worker daemon).
   ============================================================================= */
import type {
  ReplayMode,
  RetryPolicy,
  TaskRunResult,
  TriggerItem,
  TriggerOptions,
} from '@better-trigger/core';
import { registry } from './registry';

/** Per-step options. */
export interface StepOptions {
  /** Step-level retry policy; overrides the task-level policy for this step. */
  retry?: RetryPolicy;
}

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

/** Wait primitives. */
export interface RunWait {
  /** Suspend the run for a duration ("24h", "10m", 5000ms). */
  for(duration: string | number): Promise<void>;
  /** Suspend the run until an absolute date. */
  until(date: Date): Promise<void>;
}

/**
 * The context object passed to a task's run() function.
 * `TOutput` is unused here but kept for symmetry with handles.
 */
export interface RunCtx {
  /**
   * Run a durable step. The result is memoized: on replay the cached output is
   * returned without re-executing `fn`. Throwing inside `fn` triggers retries
   * per the effective retry policy (step opts ?? task ?? default).
   */
  step<T>(label: string, fn: () => T | Promise<T>, opts?: StepOptions): Promise<T>;
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

/** AsyncLocalStorage holding the executor for the currently running task fn.
 *  Process-wide (see ./registry) so it survives duplicate package copies. */
export const executorStorage = registry.executorStorage;

/** Returns the active executor if called inside a running task, else undefined. */
export function currentExecutor(): RunExecutor | undefined {
  return executorStorage.getStore();
}
