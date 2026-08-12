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

  it('returns a next fire strictly after `from` for every pattern and timezone', () => {
    // A schedule the cron scan judges due is computed from that SAME db_now
    // (p1-09); the result must always land strictly after `from`, or the
    // written next_run_at would look due again on the very next tick.
    for (const pattern of ['*/1 * * * *', '0 9 * * *']) {
      for (const tz of ['UTC', 'Asia/Shanghai']) {
        const next = nextCronAt(pattern, tz, FROM);
        expect(next).toBeInstanceOf(Date);
        expect(next!.getTime()).toBeGreaterThan(FROM.getTime());
      }
    }
    // A schedule that has been due for a while still steps forward from the
    // instant that judged it due, never back before it.
    const past = new Date('2026-07-30T07:58:30.000Z');
    const next = nextCronAt('*/1 * * * *', 'UTC', past);
    expect(next!.getTime()).toBeGreaterThan(past.getTime());
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
