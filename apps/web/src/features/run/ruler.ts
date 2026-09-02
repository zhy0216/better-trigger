/* =============================================================================
   Better Trigger — waterfall time-ruler tick math (pure, unit-testable).

   A run's timeline is drawn from a span of 1s up to "24h" waits and beyond. A
   fixed 1s grid would render one absolutely-positioned div per second — 3.6k
   for an hour, 86.4k for a day — and it re-renders every 2s poll while the run
   is non-terminal. Pick the coarsest friendly step that keeps the tick count
   bounded so the ruler stays cheap regardless of the span.
   ============================================================================= */

export const MAX_RULER_TICKS = 60;

const TICK_STEPS_MS = [
  1_000, 5_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000,
  15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 3_600_000, 3 * 3_600_000,
  6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000,
];

export interface RulerTick {
  ms: number;
  label: string;
}

function stepFor(totalMs: number): number {
  for (const step of TICK_STEPS_MS) {
    if (Math.floor(totalMs / step) + 1 <= MAX_RULER_TICKS) return step;
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
}

function labelFor(ms: number, step: number): string {
  if (step >= 3_600_000) return ms / 3_600_000 + 'h';
  if (step >= 60_000) return ms / 60_000 + 'm';
  return ms / 1_000 + 's';
}

/** Ticks from 0..totalMs at a step chosen to stay under MAX_RULER_TICKS. A
 *  short run (< 60s) keeps the original 1s grid, so its look is unchanged. */
export function rulerTicks(totalMs: number): RulerTick[] {
  const step = stepFor(totalMs);
  const ticks: RulerTick[] = [];
  for (let ms = 0; ms <= totalMs; ms += step) ticks.push({ ms, label: labelFor(ms, step) });
  return ticks;
}
