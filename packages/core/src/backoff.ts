/* =============================================================================
   @better-trigger/core — retry backoff computation (shared by SDK and server).
   ============================================================================= */
import { DEFAULT_RETRY, type RetryPolicy } from './types';

/**
 * Merge a partial policy over the defaults. Deliberately per-field `??`, NOT
 * `{ ...DEFAULT_RETRY, ...policy }`: with `exactOptionalPropertyTypes` off, a
 * spread can carry an explicit `undefined` (e.g. `retry: { maxAttempts:
 * maybe ? n : undefined }`) that OVERRIDES the default and lands in a NOT
 * NULL column as an opaque 500. Explicit undefined and absent are the same
 * here (p2-24).
 */
export function resolveRetryPolicy(policy?: RetryPolicy): Required<RetryPolicy> {
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
