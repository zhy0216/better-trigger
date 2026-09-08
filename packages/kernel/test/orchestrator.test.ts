/* =============================================================================
   @better-trigger/kernel — orchestrator timer, cron and lease validation.
   nextCronAt is the pure half of the cron loop: every schedules.next_run_at the
   scheduler writes comes out of it, so the timezone argument actually landing on
   croner (and an invalid pattern failing loudly rather than silently never
   firing) is what the pure cron tests pin. Timer boundary tests use fake
   timers and pool spies; the PG suite checks lease storage and renewal on
   an isolated database.
   ============================================================================= */
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextCronAt, startOrchestrator } from '../src/orchestrator';
import { describePg, withPg } from './pg/helpers';

const INTERVALS = [
  'timerIntervalMs', 'cronIntervalMs', 'reaperIntervalMs', 'gcIntervalMs', 'strandedIntervalMs',
] as const;

describe('orchestrator timer validation before resource creation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(INTERVALS)('%s rejects all invalid values before creating any timer or DB work', (name) => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const query = vi.fn();
    const connect = vi.fn();
    for (const value of [0, -1, 1.5, NaN, Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1, '1000', null, true]) {
      expect(() => startOrchestrator({ query, connect } as unknown as Pool, console, {
        retentionMs: 86_400_000, stranded: true, [name]: value,
      }), `${name}=${value}`).toThrow(name);
      expect(interval).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it.each([1, 2_147_483_647])('passes the exact valid delay %i to all configurable timers', (ms) => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const handle = startOrchestrator({} as Pool, console, {
      ...Object.fromEntries(INTERVALS.map((name) => [name, ms])),
      workerOffline: false, retentionMs: 365 * 86_400_000, stranded: true,
    });
    try {
      expect(interval.mock.calls.map((call) => call[1])).toEqual([ms, ms, ms, ms, ms]);
    } finally {
      handle.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps defaults and boolean loop disabling, with GC and stranded scans off by default', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const defaults = startOrchestrator({} as Pool, console);
    expect(interval.mock.calls.map((call) => call[1])).toEqual([1000, 1000, 10_000, 30_000]);
    defaults.stop();
    interval.mockClear();
    const disabled = startOrchestrator({} as Pool, console, {
      waits: false, cron: false, reaper: false, workerOffline: false, stranded: false,
    });
    expect(interval).not.toHaveBeenCalled();
    disabled.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describePg('worker lease duration storage at timer boundaries', () => {
  it('claims and renews the full derived maximum without truncation or invalid dates', async () => {
    await withPg('lease_timer_bounds', async ({ kernel, pool }) => {
      const namespace = { projectId: 'lease-bounds', env: 'test' };
      const { workerId } = await kernel.registerWorker({
        runtime: 'test', codeVersion: 'v1', concurrency: 1, namespaces: [namespace],
        tasks: [{ id: 'lease-boundary', codeVersion: 'v1' }],
      });
      for (const leaseMs of [1500, 60_000, 2_147_483_648, 6_442_450_943]) {
        const { runId } = await kernel.trigger({ taskId: 'lease-boundary', payload: null, namespace });
        const claimed = await kernel.claimRuns({
          workerId, taskIds: ['lease-boundary'], namespaces: [namespace], limit: 1, leaseMs,
        });
        expect(claimed.map((run) => run.id)).toEqual([runId]);
        const { rows } = await pool.query(
          'SELECT lease_until, extract(epoch FROM (lease_until - locked_at)) * 1000 AS duration FROM queue WHERE run_id = $1',
          [runId],
        );
        expect(Number(rows[0].duration)).toBe(leaseMs);
        expect(Number.isFinite(rows[0].lease_until.getTime())).toBe(true);
        // Move the stored expiry into the past so renewal must actually write it.
        await pool.query("UPDATE queue SET lease_until = now() - interval '1 second' WHERE run_id = $1", [runId]);
        const renewed = await kernel.heartbeat({ workerId, runIds: [runId], namespaces: [namespace], leaseMs });
        expect(renewed.lostRunIds).toEqual([]);
        const after = await pool.query('SELECT lease_until FROM queue WHERE run_id = $1', [runId]);
        expect(after.rows[0].lease_until.getTime()).toBeGreaterThanOrEqual(rows[0].lease_until.getTime());
        // Complete this claimed run so the next boundary has its own claim.
        await kernel.completeRun({
          runId, namespace, workerId, fencingToken: claimed[0]!.fencingToken, output: null,
        });
      }
    });
  });
});

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
