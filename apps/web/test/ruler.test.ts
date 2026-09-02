/* =============================================================================
   Better Trigger — waterfall ruler tick decimation (T2).

   The ruler used to emit one absolutely-positioned div per second, unbounded:
   an hour-long run rendered 3.6k ticks and a 24h wait ~86k, re-laid-out every
   2s poll. rulerTicks must keep the count bounded for short, hour, and day
   spans while leaving a sub-minute run on the original 1s grid.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { MAX_RULER_TICKS, rulerTicks } from '../src/features/run/ruler';

describe('rulerTicks', () => {
  it('bounds the tick count across short, hour, and day spans', () => {
    for (const totalMs of [60_000, 5 * 60_000, 3_600_000, 12 * 3_600_000, 86_400_000]) {
      const ticks = rulerTicks(totalMs);
      expect(ticks.length).toBeLessThanOrEqual(MAX_RULER_TICKS);
      expect(ticks[0]?.ms).toBe(0);
      expect(ticks[ticks.length - 1]!.ms).toBeLessThanOrEqual(totalMs);
    }
  });

  it('keeps the 1s grid (unchanged look) for a sub-minute run', () => {
    const ticks = rulerTicks(5_000);
    expect(ticks.map((t) => t.ms)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(ticks.map((t) => t.label)).toEqual(['0s', '1s', '2s', '3s', '4s', '5s']);
  });

  it('coarsens to a whole-minute grid for a one-hour span', () => {
    const ticks = rulerTicks(3_600_000);
    expect(ticks.length).toBeLessThanOrEqual(MAX_RULER_TICKS);
    // No longer 3600 one-second ticks.
    expect(ticks.length).toBeLessThan(60);
    for (const t of ticks) expect(t.ms % 60_000).toBe(0);
  });

  it('coarsens to a sub-hour grid and stays bounded for a full day', () => {
    const ticks = rulerTicks(86_400_000);
    expect(ticks.length).toBeLessThanOrEqual(MAX_RULER_TICKS);
    expect(ticks.length).toBeGreaterThan(1);
    for (const t of ticks) expect(Number.isFinite(t.ms)).toBe(true);
  });
});
