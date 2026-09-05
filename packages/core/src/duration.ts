/* =============================================================================
   @better-trigger/core — duration parsing ("24h", "10m", 5000).
   ============================================================================= */
import { KernelError } from './kernel-errors';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Date's representable range: ±8.64e15 ms from the epoch (the year 275760).
 *  Anything beyond it makes `new Date(...)` an Invalid Date that only blows up
 *  later, at toISOString(). Reject it where the Date is built. */
const DATE_MAX_MS = 8.64e15;

/**
 * Parse a duration into milliseconds.
 * Accepts a number (ms) or strings like "500ms", "10s", "5m", "2h", "7d", "1w",
 * including compounds like "1h30m". Throws on anything unparseable or negative.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`invalid duration: ${input}`);
    }
    return Math.floor(input);
  }
  const str = input.trim().toLowerCase();
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g;
  let total = 0;
  let matches = 0;
  const seen = new Set<string>();
  for (const m of str.matchAll(re)) {
    const unit = m[2];
    // "1m1m" was silently accepted as 120000 — a typo (or a pasted compound)
    // that doubles a unit reads as a very different wait. Reject it, naming
    // the duplicate.
    if (seen.has(unit)) {
      throw new Error(`invalid duration: "${input}" — repeated unit "${unit}"`);
    }
    seen.add(unit);
    total += parseFloat(m[1]) * UNIT_MS[unit];
    matches += 1;
  }
  const leftover = str.replace(re, '').replace(/\s+/g, '');
  if (matches === 0 || leftover !== '') {
    throw new Error(`invalid duration: "${input}" (expected e.g. "30s", "10m", "24h")`);
  }
  if (!Number.isFinite(total)) {
    throw new Error(`invalid duration: "${input}" — milliseconds must be finite`);
  }
  return Math.floor(total);
}

/** Resolve a duration (relative to `from`, default now) to an absolute Date. */
export function durationToDate(input: string | number, from: Date = new Date()): Date {
  const ms = parseDuration(input);
  const fromMs = from.getTime();
  if (!Number.isFinite(fromMs)) {
    throw new KernelError('bad_request', 'duration from must be a valid Date');
  }
  const time = fromMs + ms;
  if (!Number.isFinite(time) || time > DATE_MAX_MS || time < -DATE_MAX_MS) {
    // Not a plain "invalid duration" Error: this one is well-formed but too big
    // for a Date, so it used to silently produce an Invalid Date and only
    // explode at toISOString(). Naming the input keeps it debuggable.
    throw new KernelError(
      'bad_request',
      `duration "${String(input)}" is out of range — it cannot be added to a Date`,
    );
  }
  return new Date(time);
}
