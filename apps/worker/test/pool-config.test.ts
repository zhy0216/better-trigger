/* =============================================================================
   @better-trigger/worker — business-pool config derivation (todos/p1-11).

   The daemon sizes its pool to its own work — max = concurrency + 8 headroom
   for the orchestrator loops, heartbeat, waiter sweep and HTTP slack — with
   three env overrides. The derivation is a pure function (pool-config.ts) so
   the defaults and every override path are testable without booting the
   daemon. What is under test:

     - the default derivation (concurrency 5 → max 13);
     - BETTER_TRIGGER_POOL_MAX wins over the concurrency derivation;
     - 0 is a legal value where the codebase says so (statement timeout off,
       connect timeout = wait forever), and refused where it is not (pool max 0);
     - garbage env values THROW rather than silently falling back — a pool
       sized by a typo'd env is a pool that is wrong in exactly the way nobody
       noticed, so it must fail at startup.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { derivePoolConfig } from '../src/pool-config';

const NO_ENV = {} as Record<string, string | undefined>;

describe('derivePoolConfig', () => {
  it('defaults to concurrency + 8 headroom, 10s connect timeout, 30s statement timeout', () => {
    expect(derivePoolConfig(5, NO_ENV)).toEqual({
      max: 13,
      connectionTimeoutMillis: 10_000,
      statementTimeoutMs: 30_000,
    });
  });

  it('BETTER_TRIGGER_POOL_MAX wins over the concurrency derivation', () => {
    expect(
      derivePoolConfig(20, { BETTER_TRIGGER_POOL_MAX: '50' }),
    ).toMatchObject({ max: 50 });
  });

  it('accepts all three overrides at once', () => {
    expect(
      derivePoolConfig(3, {
        BETTER_TRIGGER_POOL_MAX: '12',
        BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS: '5000',
        BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS: '0',
      }),
    ).toEqual({
      max: 12,
      connectionTimeoutMillis: 5_000,
      statementTimeoutMs: 0,
    });
  });

  it('treats statement timeout 0 as "off" and connect timeout 0 as "wait forever"', () => {
    expect(
      derivePoolConfig(5, { BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS: '0' }).statementTimeoutMs,
    ).toBe(0);
    expect(
      derivePoolConfig(5, { BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS: '0' }).connectionTimeoutMillis,
    ).toBe(0);
  });

  it('a fractional or negative timeout is refused, not clamped', () => {
    expect(() =>
      derivePoolConfig(5, { BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS: '1.5' }),
    ).toThrow(/BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS must be a non-negative integer/);
    expect(() =>
      derivePoolConfig(5, { BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS: '-1' }),
    ).toThrow(/BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS must be a non-negative integer/);
  });

  it('garbage env values throw at startup instead of silently falling back', () => {
    expect(() => derivePoolConfig(5, { BETTER_TRIGGER_POOL_MAX: 'lots' })).toThrow(
      /BETTER_TRIGGER_POOL_MAX must be a positive integer/,
    );
    expect(() => derivePoolConfig(5, { BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS: 'abc' })).toThrow(
      /BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS must be a non-negative integer/,
    );
    expect(() => derivePoolConfig(5, { BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS: 'thirty' })).toThrow(
      /BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS must be a non-negative integer/,
    );
  });

  it('refuses a pool max of 0: a pool with no connections could not serve anything', () => {
    expect(() => derivePoolConfig(5, { BETTER_TRIGGER_POOL_MAX: '0' })).toThrow(
      /BETTER_TRIGGER_POOL_MAX must be a positive integer/,
    );
  });
});
