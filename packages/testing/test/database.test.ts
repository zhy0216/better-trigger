/* =============================================================================
   @better-trigger/testing — database provisioning unit tests (T3 acceptance).

   @better-trigger/db is mocked: what is under test is URL derivation, port
   validation, and pool ownership on the failure paths — none of which need a
   live Postgres.
   ============================================================================= */
import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ createPool: vi.fn(), migrate: vi.fn() }));
vi.mock('@better-trigger/db', () => db);

import { baseUrl, databaseUrlFor, portFromEnv, resetDb } from '../src/database';

interface FakePool {
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  readonly ended: { n: number };
}

function fakePool(): FakePool {
  const ended = { n: 0 };
  return {
    query: vi.fn(async () => ({ rows: [] })),
    end: vi.fn(async () => {
      ended.n += 1;
    }),
    ended,
  };
}

const ENV = 'BT_TESTING_UNIT_PORT';

afterEach(() => {
  delete process.env[ENV];
  delete process.env.DATABASE_URL;
  vi.resetAllMocks();
});

describe('baseUrl / databaseUrlFor', () => {
  it('strips query and hash alongside the db path', () => {
    expect(baseUrl('postgres://u@h:5432/bt?sslmode=require')).toBe('postgres://u@h:5432');
    expect(baseUrl('postgres://u:p@h:5432/bt#x')).toBe('postgres://u:p@h:5432');
    expect(baseUrl('postgres://localhost:5432/better_trigger')).toBe('postgres://localhost:5432');
  });

  it('derives a legal per-scenario URL from a queried DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://u@h:5432/bt?sslmode=require';
    expect(databaseUrlFor('scenario1')).toBe('postgres://u@h:5432/scenario1');
  });
});

describe('portFromEnv', () => {
  it('falls back when unset or empty', () => {
    expect(portFromEnv(ENV, 8080)).toBe(8080);
    process.env[ENV] = '';
    expect(portFromEnv(ENV, 8080)).toBe(8080);
  });

  it('accepts a valid port', () => {
    process.env[ENV] = '4902';
    expect(portFromEnv(ENV, 8080)).toBe(4902);
  });

  it('throws naming the variable instead of yielding NaN', () => {
    for (const bad of ['abc', '12.5', '0', '70000', '1e400']) {
      process.env[ENV] = bad;
      expect(() => portFromEnv(ENV, 8080)).toThrow(`${ENV} must be an integer TCP port`);
    }
  });
});

describe('resetDb', () => {
  it('closes the pool it opened when migrate fails (no leak)', async () => {
    const admin = fakePool();
    const target = fakePool();
    db.createPool.mockReturnValueOnce(admin).mockReturnValueOnce(target);
    db.migrate.mockRejectedValueOnce(new Error('migration boom'));

    await expect(resetDb({ name: 'leaky' })).rejects.toThrow('migration boom');
    expect(target.end).toHaveBeenCalledTimes(1);
    expect(admin.end).toHaveBeenCalledTimes(1);
    expect(admin.query.mock.calls[0][0]).toMatch(/^DROP DATABASE IF EXISTS leaky/);
  });

  it('returns the provisioned database on success and ends the pool once', async () => {
    const admin = fakePool();
    const target = fakePool();
    db.createPool.mockReturnValueOnce(admin).mockReturnValueOnce(target);
    db.migrate.mockResolvedValueOnce(undefined);

    process.env.DATABASE_URL = 'postgres://u@h:5432/bt?sslmode=require';
    const test = await resetDb({ name: 'good' });
    expect(test.url).toBe('postgres://u@h:5432/good');
    expect(db.migrate).toHaveBeenCalledWith(target);
    await test.end();
    await test.end();
    expect(target.ended.n).toBe(1);
  });

  it('honours the env var name override', async () => {
    db.createPool.mockImplementation(() => fakePool());
    process.env[ENV] = 'forced_db';
    const test = await resetDb({ name: 'default_name', envVar: ENV, migrate: false });
    expect(test.name).toBe('forced_db');
  });

  it('rejects unsafe database names', async () => {
    await expect(resetDb({ name: 'bad;name' })).rejects.toThrow('unsafe database name');
  });
});
