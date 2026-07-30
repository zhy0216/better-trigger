/* =============================================================================
   @better-trigger/kernel — cron scheduling unit tests.
   nextCronAt is the pure half of the cron loop: every schedules.next_run_at the
   scheduler writes comes out of it, so the timezone argument actually landing on
   croner (and an invalid pattern failing loudly rather than silently never
   firing) is what these pin. No pool is touched.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { nextCronAt } from '../src/orchestrator';

/** 2026-07-30 08:00Z — a Thursday; 16:00 in Asia/Shanghai. */
const FROM = new Date('2026-07-30T08:00:00.000Z');

describe('nextCronAt', () => {
  it('returns the next occurrence strictly after `from`', () => {
    expect(nextCronAt('0 9 * * *', 'UTC', FROM)?.toISOString()).toBe(
      '2026-07-30T09:00:00.000Z',
    );
    // Standing exactly on an occurrence must move to the following one.
    const onTheHour = new Date('2026-07-30T09:00:00.000Z');
    expect(nextCronAt('0 9 * * *', 'UTC', onTheHour)?.toISOString()).toBe(
      '2026-07-31T09:00:00.000Z',
    );
  });

  it('honors step patterns', () => {
    expect(nextCronAt('*/5 * * * *', 'UTC', FROM)?.toISOString()).toBe(
      '2026-07-30T08:05:00.000Z',
    );
  });

  it('resolves the pattern in the given timezone, not the host one', () => {
    // 08:00Z is already 16:00 in Shanghai, so 09:00 local is tomorrow → 01:00Z.
    expect(nextCronAt('0 9 * * *', 'Asia/Shanghai', FROM)?.toISOString()).toBe(
      '2026-07-31T01:00:00.000Z',
    );
    expect(nextCronAt('0 9 * * *', 'America/New_York', FROM)?.toISOString()).toBe(
      '2026-07-30T13:00:00.000Z',
    );
  });

  it('honors day-of-week fields', () => {
    // FROM is a Thursday; the next Monday 00:00Z is 2026-08-03.
    expect(nextCronAt('0 0 * * 1', 'UTC', FROM)?.toISOString()).toBe(
      '2026-08-03T00:00:00.000Z',
    );
  });

  it('defaults `from` to now and returns a future date', () => {
    const next = nextCronAt('*/1 * * * *', 'UTC');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it('throws on an unparseable pattern instead of returning null', () => {
    expect(() => nextCronAt('not a cron', 'UTC', FROM)).toThrow();
    expect(() => nextCronAt('99 * * * *', 'UTC', FROM)).toThrow();
  });

  it('throws on an unknown timezone', () => {
    expect(() => nextCronAt('0 9 * * *', 'Mars/Olympus_Mons', FROM)).toThrow();
  });
});
