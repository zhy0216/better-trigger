/* =============================================================================
   @better-trigger/core — retry backoff computation (shared by SDK and server).
   ============================================================================= */
import { DEFAULT_RETRY, type RetryPolicy } from './types';

/** Merge a partial policy over the defaults. */
export function resolveRetryPolicy(policy?: RetryPolicy): Required<RetryPolicy> {
  return { ...DEFAULT_RETRY, ...(policy ?? {}) };
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
