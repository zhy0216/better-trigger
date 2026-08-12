/* =============================================================================
   @better-trigger/core — duration parsing unit tests.
   parseDuration is the front door for every ctx.wait / TriggerOptions.delay, so
   the invalid cases matter as much as the valid ones: silently accepting "10"
   or "5m banana" would turn a typo into a wait of the wrong magnitude.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { durationToDate, parseDuration } from '../src/duration';
import { KernelError } from '../src/kernel-errors';

/** Run `fn` and return whatever it throws; fails the test if it does not. */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected fn to throw');
}

describe('parseDuration — numbers', () => {
  it('passes finite non-negative numbers through as ms', () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(5_000)).toBe(5_000);
  });

  it('floors fractional ms', () => {
    expect(parseDuration(1.9)).toBe(1);
  });

  it('rejects negative and non-finite numbers', () => {
    expect(() => parseDuration(-1)).toThrow(/invalid duration: -1/);
    expect(() => parseDuration(Number.NaN)).toThrow(/invalid duration/);
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(/invalid duration/);
  });
});

describe('parseDuration — strings', () => {
  it('parses every supported unit', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('10s')).toBe(10_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('1w')).toBe(604_800_000);
  });

  it('sums compounds and ignores ordering', () => {
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('30m1h')).toBe(5_400_000);
    expect(parseDuration('1d2h3m4s')).toBe(86_400_000 + 7_200_000 + 180_000 + 4_000);
  });

  it('accepts fractions, surrounding whitespace and mixed case', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('  10 m  ')).toBe(600_000);
    expect(parseDuration('10S')).toBe(10_000);
    expect(parseDuration('24H')).toBe(86_400_000);
  });

  it('prefers "ms" over "m" + stray "s"', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1m500ms')).toBe(60_500);
  });

  it('floors the total, not each term', () => {
    // The floor applies to the summed ms, not per term: 0.9s + 500ms is 1400,
    // never 900 + 500 truncated differently. (Repeated units like "0.5ms0.5ms"
    // used to prove this and are now rejected — see the duplicate-unit test.)
    expect(parseDuration('0.9s500ms')).toBe(1_400);
    expect(parseDuration('2.5s')).toBe(2_500);
  });

  it('rejects anything with no unit or with leftover text', () => {
    for (const bad of ['', '   ', '10', 'abc', '10x', '5m banana', 'in 5 minutes', '-5m']) {
      expect(() => parseDuration(bad), `expected "${bad}" to be rejected`).toThrow(
        /invalid duration/,
      );
    }
  });

  it('names the offending input in the error message', () => {
    expect(() => parseDuration('10x')).toThrow(
      'invalid duration: "10x" (expected e.g. "30s", "10m", "24h")',
    );
  });

  it('rejects repeated units, naming the duplicate', () => {
    // "1m1m" used to be silently accepted as 120000 — a pasted/typo'd compound
    // doubling a unit reads as a very different wait. Now it is a hard error.
    expect(() => parseDuration('1m1m')).toThrow(/repeated unit "m"/);
    expect(() => parseDuration('1m1m')).toThrow(/"1m1m"/);
    expect(() => parseDuration('0.5ms0.5ms')).toThrow(/repeated unit "ms"/);
    // Different units are still fine (no duplicate).
    expect(parseDuration('1m1s')).toBe(61_000);
  });
});

describe('durationToDate', () => {
  it('offsets from the given instant', () => {
    const from = new Date('2026-07-30T12:00:00.000Z');
    expect(durationToDate('90m', from).toISOString()).toBe('2026-07-30T13:30:00.000Z');
    expect(durationToDate(1_500, from).toISOString()).toBe('2026-07-30T12:00:01.500Z');
  });

  it('leaves the source date untouched', () => {
    const from = new Date('2026-07-30T12:00:00.000Z');
    durationToDate('1d', from);
    expect(from.toISOString()).toBe('2026-07-30T12:00:00.000Z');
  });

  it('propagates invalid durations instead of producing an Invalid Date', () => {
    expect(() => durationToDate('soon')).toThrow(/invalid duration/);
  });

  it('rejects an out-of-range duration as a KernelError naming the input, not an Invalid Date', () => {
    // 20000000w ≈ 1.2e16 ms — past Date's ±8.64e15 ms range, so this used to
    // build an Invalid Date that only exploded at toISOString().
    expect(() => durationToDate('20000000w')).toThrow(KernelError);
    expect(() => durationToDate('20000000w')).toThrow(/"20000000w"/);
    expect(() => durationToDate('20000000w')).toThrow(/out of range/);
    // Same for a numeric duration that overflows when added to a date.
    expect(() => durationToDate(1e16)).toThrow(KernelError);
    expect(() => durationToDate(1e16)).toThrow(/out of range/);

    const err = captureThrow(() => durationToDate('20000000w')) as KernelError;
    expect(err.code).toBe('bad_request');
  });

  it('keeps durations inside Date range working', () => {
    const from = new Date('2026-07-30T12:00:00.000Z');
    // Large but representable (~3800 years) — must still produce a real Date.
    expect(durationToDate('200000w', from).toISOString()).toBeTruthy();
    expect(Number.isNaN(durationToDate('200000w', from).getTime())).toBe(false);
    // Exactly at Date's max instant (the year 275760), measured from the epoch.
    expect(new Date(8.64e15).toISOString()).toBeTruthy();
  });
});
