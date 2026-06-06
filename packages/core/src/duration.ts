/* =============================================================================
   @better-trigger/core — duration parsing ("24h", "10m", 5000).
   ============================================================================= */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

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
  for (const m of str.matchAll(re)) {
    total += parseFloat(m[1]) * UNIT_MS[m[2]];
    matches += 1;
  }
  const leftover = str.replace(re, '').replace(/\s+/g, '');
  if (matches === 0 || leftover !== '') {
    throw new Error(`invalid duration: "${input}" (expected e.g. "30s", "10m", "24h")`);
  }
  return Math.floor(total);
}

/** Resolve a duration (relative to `from`, default now) to an absolute Date. */
export function durationToDate(input: string | number, from: Date = new Date()): Date {
  return new Date(from.getTime() + parseDuration(input));
}
