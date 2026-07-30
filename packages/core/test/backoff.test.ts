/* =============================================================================
   @better-trigger/core — retry backoff unit tests.
   `rand` is injectable precisely so the jitter can be pinned: rand()=0.5 means
   jitter 1.0, i.e. the raw curve, and 0 / 1 give the exact jitter envelope.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { computeBackoffMs, resolveRetryPolicy } from '../src/backoff';
import { DEFAULT_RETRY } from '../src/types';

describe('resolveRetryPolicy', () => {
  it('returns the defaults when no policy is given', () => {
    expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY);
    expect(resolveRetryPolicy(undefined)).toEqual(DEFAULT_RETRY);
  });

  it('merges a partial policy over the defaults, field by field', () => {
    expect(resolveRetryPolicy({ maxAttempts: 7 })).toEqual({
      maxAttempts: 7,
      baseMs: DEFAULT_RETRY.baseMs,
      factor: DEFAULT_RETRY.factor,
      maxMs: DEFAULT_RETRY.maxMs,
    });
  });

  it('does not mutate DEFAULT_RETRY', () => {
    resolveRetryPolicy({ baseMs: 1 });
    expect(DEFAULT_RETRY.baseMs).toBe(1_000);
  });
});

describe('computeBackoffMs', () => {
  const noJitter = () => 0.5; // 0.8 + 0.5 * 0.4 = 1.0

  it('follows baseMs * factor^(attempt-1) with the jitter neutralized', () => {
    expect(computeBackoffMs(1, undefined, noJitter)).toBe(1_000);
    expect(computeBackoffMs(2, undefined, noJitter)).toBe(2_000);
    expect(computeBackoffMs(3, undefined, noJitter)).toBe(4_000);
    expect(computeBackoffMs(4, undefined, noJitter)).toBe(8_000);
  });

  it('honors a custom base and factor', () => {
    const policy = { baseMs: 250, factor: 3 };
    expect(computeBackoffMs(1, policy, noJitter)).toBe(250);
    expect(computeBackoffMs(2, policy, noJitter)).toBe(750);
    expect(computeBackoffMs(3, policy, noJitter)).toBe(2_250);
  });

  it('clamps the raw delay at maxMs before jittering', () => {
    // 1000 * 2^19 is ~9.3 minutes; the default cap is 5.
    expect(computeBackoffMs(20, undefined, noJitter)).toBe(DEFAULT_RETRY.maxMs);
    expect(computeBackoffMs(20, undefined, () => 0)).toBe(
      Math.round(DEFAULT_RETRY.maxMs * 0.8),
    );
    expect(computeBackoffMs(2, { maxMs: 1_500 }, noJitter)).toBe(1_500);
  });

  it('treats attempt 0 / negative as the first attempt (exponent floors at 0)', () => {
    expect(computeBackoffMs(0, undefined, noJitter)).toBe(1_000);
    expect(computeBackoffMs(-5, undefined, noJitter)).toBe(1_000);
  });

  it('keeps the jitter inside [0.8, 1.2) of the raw delay', () => {
    const raw = 4_000; // attempt 3 under the defaults
    expect(computeBackoffMs(3, undefined, () => 0)).toBe(raw * 0.8);
    // rand() is exclusive of 1, so 1.2x is the open upper bound — but the
    // rounding can land on it, hence <=.
    expect(computeBackoffMs(3, undefined, () => 0.999_999)).toBeLessThanOrEqual(raw * 1.2);
    expect(computeBackoffMs(3, undefined, () => 0.999_999)).toBeGreaterThan(raw * 1.199);

    for (let i = 0; i < 200; i += 1) {
      const ms = computeBackoffMs(3);
      expect(ms).toBeGreaterThanOrEqual(raw * 0.8);
      expect(ms).toBeLessThanOrEqual(raw * 1.2);
    }
  });

  it('returns whole milliseconds', () => {
    expect(computeBackoffMs(1, { baseMs: 333 }, () => 0.123_456)).toBe(
      Math.round(333 * (0.8 + 0.123_456 * 0.4)),
    );
    expect(Number.isInteger(computeBackoffMs(2, { baseMs: 777 }))).toBe(true);
  });
});
