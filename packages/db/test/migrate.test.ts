/* =============================================================================
   @better-trigger/db — migration advisory-lock unit tests. No live Postgres: a
   stub pool records the call sequence, and drizzle's migrator is mocked away.
   What is under test is not the SQL but the *session* discipline — a
   session-level pg_advisory_lock only unlocks from the connection that took it,
   so lock, migrate and unlock all have to happen on one pinned client.
   ============================================================================= */
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { drizzleMigrateMock } = vi.hoisted(() => ({ drizzleMigrateMock: vi.fn() }));
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: drizzleMigrateMock }));

import { migrate } from '../src/migrate';

const LOCK = 'SELECT pg_advisory_lock($1, $2)';
const UNLOCK = 'SELECT pg_advisory_unlock($1, $2)';

interface Call {
  op: 'connect' | 'query' | 'migrate' | 'release';
  client?: number;
  sql?: string;
  params?: unknown[];
}

/** A pool that hands out a fresh, numbered client per connect(). */
function stubPool(): { pool: pg.Pool; calls: Call[]; poolQuery: ReturnType<typeof vi.fn> } {
  const calls: Call[] = [];
  let next = 0;
  const poolQuery = vi.fn();
  const pool = {
    connect: async () => {
      const client = ++next;
      calls.push({ op: 'connect', client });
      return {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ op: 'query', client, sql, params });
          return { rows: [] };
        },
        release: () => calls.push({ op: 'release', client }),
      };
    },
    query: poolQuery,
  } as unknown as pg.Pool;
  return { pool, calls, poolQuery };
}

beforeEach(() => {
  drizzleMigrateMock.mockReset();
});

describe('migrate — advisory lock', () => {
  it('locks, migrates, unlocks — in that order, on one client', async () => {
    const { pool, calls } = stubPool();
    drizzleMigrateMock.mockImplementation(async () => {
      calls.push({ op: 'migrate' });
    });

    await migrate(pool);

    expect(calls.map((c) => c.op)).toEqual(['connect', 'query', 'migrate', 'query', 'release']);
    expect(calls[1]).toMatchObject({ sql: LOCK, client: 1 });
    expect(calls[3]).toMatchObject({ sql: UNLOCK, client: 1 });
    expect(calls[4]).toMatchObject({ client: 1 });
  });

  it('unlocks on the same session that locked — never a second client', async () => {
    const { pool, calls, poolQuery } = stubPool();

    await migrate(pool);

    // One connect only: a second one would mean the unlock could land on a
    // different backend, which is the silent-deadlock failure being guarded.
    expect(calls.filter((c) => c.op === 'connect')).toHaveLength(1);
    const clients = new Set(calls.filter((c) => c.op === 'query').map((c) => c.client));
    expect(clients).toEqual(new Set([1]));
    // pool.query() is exactly the mistake: it picks an arbitrary idle client.
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('runs the migration on the locked client, not on the pool', async () => {
    const { pool, calls } = stubPool();
    let migratedOn: unknown;
    drizzleMigrateMock.mockImplementation(async (db: { $client: unknown }) => {
      migratedOn = db.$client;
    });

    await migrate(pool);

    expect(migratedOn).toBeDefined();
    expect(migratedOn).not.toBe(pool);
    expect(calls.filter((c) => c.op === 'connect')).toHaveLength(1);
  });

  it('uses the two-argument key space, away from the kernel lock', async () => {
    const { pool, calls } = stubPool();

    await migrate(pool);

    // 'btmg'. The (int4, int4) space is disjoint from the one-argument bigint
    // space used by queue.ts's concurrency limiter.
    expect(calls[1]).toMatchObject({ sql: LOCK, params: [0x62_74_6d_67, 1] });
    expect(calls[2]).toMatchObject({ sql: UNLOCK, params: [0x62_74_6d_67, 1] });
  });

  it('unlocks and releases when the migration throws, and rethrows', async () => {
    const { pool, calls } = stubPool();
    const boom = new Error('migration boom');
    drizzleMigrateMock.mockRejectedValue(boom);

    await expect(migrate(pool)).rejects.toThrow('migration boom');

    expect(calls.map((c) => c.op)).toEqual(['connect', 'query', 'query', 'release']);
    expect(calls[2]).toMatchObject({ sql: UNLOCK, client: 1 });
    expect(calls[3]).toMatchObject({ op: 'release', client: 1 });
  });
});
