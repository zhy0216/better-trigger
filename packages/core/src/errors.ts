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

/** Convert any thrown value to a JSON-safe error record. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: typeof err === 'string' ? err : JSON.stringify(err) };
}
