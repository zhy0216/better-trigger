/* =============================================================================
   @better-trigger/worker — throttled logging unit tests.

   The point of the throttle is that a *permanent* failure (wrong password in
   DATABASE_URL) stays as cheap as a transient one: the claim loop polls every
   300ms per slot, so an unthrottled warn would push megabytes an hour and bury
   whatever else the daemon has to say. What must survive the squeeze is the
   count — "how many times did this actually happen".
   ============================================================================= */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottledLogger, describeError, errorKey } from '../src/observability';

function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      warn: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
      error: () => {},
    },
  };
}

describe('createThrottledLogger', () => {
  beforeEach(() => {
    // Fakes Date.now too, which is the clock the throttle window reads.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('squeezes 100 identical failures into a single line', () => {
    const { lines, logger } = recordingLogger();
    const log = createThrottledLogger(logger, 30_000);

    for (let i = 0; i < 100; i++) {
      log.warn('claim:28P01', 'claim failed (worker=w1, slot=0)', new Error('bad password'));
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('claim failed (worker=w1, slot=0)');
  });

  it('carries the suppressed count into the next line past the window', () => {
    const { lines, logger } = recordingLogger();
    const log = createThrottledLogger(logger, 30_000);

    for (let i = 0; i < 100; i++) log.warn('claim:28P01', 'claim failed', new Error('x'));
    vi.advanceTimersByTime(30_001);
    log.warn('claim:28P01', 'claim failed', new Error('x'));

    expect(lines).toHaveLength(2);
    // 100 calls landed, 1 printed, 99 folded — nothing is silently lost.
    expect(lines[1]).toContain('+99 more in the last 30s');
    // ...and the fold resets, so the next window starts from zero again.
    vi.advanceTimersByTime(30_001);
    log.warn('claim:28P01', 'claim failed', new Error('x'));
    expect(lines[2]).not.toContain('more in the last');
  });

  it('throttles per key, so a second kind of failure is still heard', () => {
    const { lines, logger } = recordingLogger();
    const log = createThrottledLogger(logger, 30_000);

    for (let i = 0; i < 50; i++) {
      log.warn('claim:28P01', 'claim failed', new Error('a'));
      log.warn('heartbeat:ECONNREFUSED', 'heartbeat failed', new Error('b'));
    }

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('claim failed');
    expect(lines[1]).toContain('heartbeat failed');
  });

  it('logs the stack, not just the message', () => {
    const { lines, logger } = recordingLogger();
    const log = createThrottledLogger(logger, 30_000);
    log.warn('claim:x', 'claim failed', new Error('connection refused'));
    expect(lines[0]).toContain('connection refused');
    expect(lines[0]).toContain('observability.test.ts');
  });

  it('omits the error description entirely when there is no error (T3)', () => {
    const { lines, logger } = recordingLogger();
    const log = createThrottledLogger(logger, 30_000);
    // The backpressure drop is a warning not caused by a thrown value: it used
    // to append a phantom "undefined" from describeError(undefined).
    log.warn('log-flush:backpressure', 'buffered log lines dropped under backpressure');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[better-trigger] buffered log lines dropped under backpressure');
    expect(lines[0]).not.toContain('undefined');
  });
});

describe('errorKey', () => {
  it('prefers the driver error code — the stable half of "same failure"', () => {
    const err = Object.assign(new Error('password authentication failed'), {
      code: '28P01',
    });
    expect(errorKey(err)).toBe('28P01');
  });

  it('falls back to the error name, then to the typeof', () => {
    expect(errorKey(new TypeError('nope'))).toBe('TypeError');
    expect(errorKey('a string')).toBe('string');
  });
});

describe('describeError', () => {
  it('describes an absent error as the empty string, never the literals (T3)', () => {
    expect(describeError(undefined)).toBe('');
    expect(describeError(null)).toBe('');
  });

  it('renders an Error stack and a bare value', () => {
    expect(describeError(new Error('boom'))).toContain('boom');
    expect(describeError('a string')).toBe('a string');
    expect(describeError(42)).toBe('42');
  });
});
