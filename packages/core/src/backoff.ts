/* =============================================================================
   @better-trigger/core — retry backoff computation (shared by SDK and server).
   ============================================================================= */
import { KernelError } from './kernel-errors';
import { DEFAULT_RETRY, type RetryPolicy } from './types';

/**
 * Range-check a (partial) policy, throwing the KernelError bad_request family
 * on the first out-of-range field. Every field present-but-not-undefined must
 * be a sane number: an unset field is absent, not invalid.
 *
 * Without this a garbage policy rode the full chain to the database — a NaN
 * maxAttempts survived `?? default` and 500-ed every trigger of that task, a
 * negative factor produced a negative (→ zero-delay) backoff that burned all
 * attempts in a spin, and a negative maxAttempts made the first failure
 * terminal. `label` names the policy in the message (e.g. the task id).
 */
export function validateRetryPolicy(policy?: RetryPolicy, label = 'retry'): void {
  if (policy === undefined) return;
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new KernelError('bad_request', `${label} must be an object`);
  }
  const { maxAttempts, baseMs, factor, maxMs } = policy;
  // Integer: a fractional attempt count makes `attempt < maxAttempts`
  // comparisons and the dashboard's attempt display meaningless.
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
    throw new KernelError(
      'bad_request',
      `${label}.maxAttempts must be an integer >= 1, got ${String(maxAttempts)}`,
    );
  }
  if (baseMs !== undefined && (!Number.isFinite(baseMs) || baseMs < 0)) {
    throw new KernelError(
      'bad_request',
      `${label}.baseMs must be a finite number >= 0, got ${String(baseMs)}`,
    );
  }
  // >= 1: anything smaller makes the delay SHRINK per attempt, and a negative
  // factor yields NaN delays (fractional exponent of a negative base).
  if (factor !== undefined && (!Number.isFinite(factor) || factor < 1)) {
    throw new KernelError(
      'bad_request',
      `${label}.factor must be a finite number >= 1, got ${String(factor)}`,
    );
  }
  if (maxMs !== undefined && (!Number.isFinite(maxMs) || maxMs < 0)) {
    throw new KernelError(
      'bad_request',
      `${label}.maxMs must be a finite number >= 0, got ${String(maxMs)}`,
    );
  }
}

/**
 * Merge a partial policy over the defaults, after range-checking it.
 * Deliberately per-field `??`, NOT `{ ...DEFAULT_RETRY, ...policy }`: with
 * `exactOptionalPropertyTypes` off, a spread can carry an explicit `undefined`
 * (e.g. `retry: { maxAttempts: maybe ? n : undefined }`) that OVERRIDES the
 * default and lands in a NOT NULL column as an opaque 500. Explicit undefined
 * and absent are the same here (p2-24).
 */
export function resolveRetryPolicy(policy?: RetryPolicy): Required<RetryPolicy> {
  validateRetryPolicy(policy);
  return {
    maxAttempts: policy?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
    baseMs: policy?.baseMs ?? DEFAULT_RETRY.baseMs,
    factor: policy?.factor ?? DEFAULT_RETRY.factor,
    maxMs: policy?.maxMs ?? DEFAULT_RETRY.maxMs,
  };
}

/**
 * Delay before the next attempt, in ms.
 * `attempt` is the attempt that just failed (1-based).
 * delay = min(maxMs, baseMs * factor^(attempt-1)), then jittered ×[0.8, 1.2].
 */
export function computeBackoffMs(
  attempt: number,
  policy?: RetryPolicy,
  rand: () => number = Math.random,
): number {
  const p = resolveRetryPolicy(policy);
  const raw = Math.min(p.maxMs, p.baseMs * Math.pow(p.factor, Math.max(0, attempt - 1)));
  const jitter = 0.8 + rand() * 0.4;
  return Math.round(raw * jitter);
}
