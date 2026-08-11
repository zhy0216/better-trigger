/* =============================================================================
   @better-trigger/core — error types and helpers.
   ============================================================================= */
import type { SerializedError } from './types';

/**
 * Thrown by user code to fail a run immediately without retries.
 * (PRD §5.8 — AbortError 不重试,直接失败。)
 */
export class AbortError extends Error {
  readonly isBetterTriggerAbort = true;
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(err: unknown): err is AbortError {
  return (
    err instanceof AbortError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as Record<string, unknown>).isBetterTriggerAbort === true)
  );
}

/**
 * Raised by the kernel when a step report would overwrite a COMPLETED step row
 * whose recorded replay fingerprint differs from the reporter's — i.e. the
 * task's code or its step inputs changed after the step was recorded, and
 * replaying the recorded row would feed a stale output to the new code
 * (todos/01-correctness.md C1). The kernel leaves the recorded row intact.
 *
 * The executor converts it into a non-retryable AbortError (retrying would
 * replay the same mismatch forever), so SDK users normally see it as a failed
 * run — but it is its own error type so any path that surfaces it directly is
 * recognizable via isNonDeterminismError().
 */
export class NonDeterminismError extends Error {
  readonly isBetterTriggerNonDeterminism = true;
  constructor(message: string) {
    super(message);
    this.name = 'NonDeterminismError';
  }
}

export function isNonDeterminismError(err: unknown): err is NonDeterminismError {
  return (
    err instanceof NonDeterminismError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as Record<string, unknown>).isBetterTriggerNonDeterminism === true)
  );
}

/**
 * Internal control-flow signal thrown when a run suspends on a wait.
 * The SDK executor catches it and ends the current execution silently.
 * Exported so user code that does broad `catch` can rethrow it.
 */
export class SuspendSignal extends Error {
  readonly isBetterTriggerSuspend = true;
  constructor(public readonly seq: number) {
    super(`run suspended at seq ${seq} — this signal must not be swallowed`);
    this.name = 'SuspendSignal';
  }
}

export function isSuspendSignal(err: unknown): err is SuspendSignal {
  return (
    err instanceof SuspendSignal ||
    (typeof err === 'object' &&
      err !== null &&
      (err as Record<string, unknown>).isBetterTriggerSuspend === true)
  );
}

/**
 * The other control-flow signal thrown through user code: this attempt is over
 * (its failure was already reported to the kernel) and run() is being unwound.
 * The class itself belongs to the worker's executor — user code never builds
 * one — but its brand lives here so a broad `catch` can recognize it without
 * importing the daemon (todos/01-correctness.md C6).
 */
export interface ExecutionEndedSignal extends Error {
  readonly isBetterTriggerExecutionDone: true;
}

export function isExecutionEndedSignal(err: unknown): err is ExecutionEndedSignal {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<string, unknown>).isBetterTriggerExecutionDone === true
  );
}

/**
 * True for every value the runtime throws to steer control flow: the suspend
 * signal (ctx.wait / triggerAndWait) and the end-of-execution signal. Neither
 * is a failure user code can recover from — the run is already 'waiting' or
 * finished — so a catch broad enough to see one must hand it back:
 *
 *     try { await ctx.wait.for('1h') }
 *     catch (err) { if (isControlFlowSignal(err)) throw err; ...your handling }
 *
 * This is the single predicate to reach for: `isSuspendSignal` alone leaves the
 * step-failure path still swallowing its signal.
 */
export function isControlFlowSignal(
  err: unknown,
): err is SuspendSignal | ExecutionEndedSignal {
  return isSuspendSignal(err) || isExecutionEndedSignal(err);
}

/** Convert any thrown value to a JSON-safe error record. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: typeof err === 'string' ? err : JSON.stringify(err) };
}
