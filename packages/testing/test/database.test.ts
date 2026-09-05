/* Database lifecycle tests use fake pools; real isolation is covered in database.pg.test.ts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ createPool: vi.fn(), migrate: vi.fn() }));
vi.mock('@better-trigger/db', () => db);

import { baseUrl, databaseUrlFor, portFromEnv, resetDb } from '../src/database';

function fakePool() {
  return { query: vi.fn(async (_sql: string) => ({ rows: [] })), end: vi.fn(async () => {}) };
}

const ENV = 'BT_TESTING_UNIT_PORT';
let pools: ReturnType<typeof fakePool>[];

beforeEach(() => {
  pools = [];
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/source');
  db.createPool.mockImplementation(() => {
    const pool = fakePool();
    pools.push(pool);
    return pool;
  });
  db.migrate.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

const configuredUrl = 'postgres://fake%40user:fake%3Ap%40ss%2Fword%25@host:15432/source' +
  '?sslmode=require&ssl=true&application_name=probe%20suite&connect_timeout=8#private';
const query = '?sslmode=require&ssl=true&application_name=probe%20suite&connect_timeout=8';
const authority = 'postgres://fake%40user:fake%3Ap%40ss%2Fword%25@host:15432';

describe('baseUrl / databaseUrlFor', () => {
  it('removes the pathname and fragment, retaining encoded credentials and query', () => {
    expect(baseUrl(configuredUrl)).toBe(`${authority}${query}`);
    expect(baseUrl('postgres://u:p@h:5432/bt#x')).toBe('postgres://u:p@h:5432');
  });

  it('replaces the pathname before the connection parameters', () => {
    vi.stubEnv('DATABASE_URL', configuredUrl);
    expect(databaseUrlFor('scenario1')).toBe(`${authority}/scenario1${query}`);
    expect(databaseUrlFor('postgres', baseUrl(configuredUrl))).toBe(`${authority}/postgres${query}`);
  });

  it('preserves SSL certificate paths and IPv6 in derived URLs', () => {
    const raw = 'postgres://user:password@[::1]:25432/old?sslmode=verify-full' +
      '&sslrootcert=%2Ftmp%2Fca.pem&sslcert=%2Ftmp%2Fclient.pem&sslkey=%2Ftmp%2Fkey.pem#secret';
    const url = new URL(databaseUrlFor('target', raw));
    expect(url.pathname).toBe('/target');
    expect(url.hostname).toBe('[::1]');
    expect(url.port).toBe('25432');
    expect(url.search).toBe(new URL(raw).search);
    expect(url.hash).toBe('');
  });

  it('rejects names that could change the pathname or inject URL parameters', () => {
    for (const name of ['../postgres', 'a?sslmode=disable', 'a#fragment']) {
      expect(() => databaseUrlFor(name)).toThrow('unsafe database name');
    }
  });
});

describe('portFromEnv', () => {
  it('falls back when unset or empty', () => {
    vi.stubEnv(ENV, undefined);
    expect(portFromEnv(ENV, 8080)).toBe(8080);
    vi.stubEnv(ENV, '');
    expect(portFromEnv(ENV, 8080)).toBe(8080);
  });

  it('accepts a valid port', () => {
    vi.stubEnv(ENV, '4902');
    expect(portFromEnv(ENV, 8080)).toBe(4902);
  });

  it('throws naming the variable instead of yielding NaN', () => {
    for (const bad of ['abc', '12.5', '0', '70000', '1e400']) {
      vi.stubEnv(ENV, bad);
      expect(() => portFromEnv(ENV, 8080)).toThrow(`${ENV} must be an integer TCP port`);
    }
  });
});

describe('resetDb ownership and URLs', () => {
  it('creates distinct instances concurrently for the same logical name', async () => {
    const instances = await Promise.all(Array.from({ length: 20 }, () => resetDb({ name: 'same' })));
    expect(new Set(instances.map(({ name }) => name)).size).toBe(20);
    for (const instance of instances) expect(instance.name).toMatch(/^same_[a-f0-9]{32}$/);
    const sql = pools.flatMap((pool) => pool.query.mock.calls.map(([sql]) => sql));
    expect(sql).toHaveLength(20);
    for (const instance of instances) expect(sql).toContain(`CREATE DATABASE "${instance.name}"`);
    expect(sql.every((statement) => statement.startsWith('CREATE DATABASE'))).toBe(true);
    await Promise.all(instances.map((instance) => instance.drop()));
  });

  it('passes the correct URLs to admin, migrated target and cleanup pools', async () => {
    vi.stubEnv('DATABASE_URL', configuredUrl);
    const instance = await resetDb({ name: 'good' });
    expect(instance.url).toBe(`${authority}/${instance.name}${query}`);
    expect(db.createPool.mock.calls).toEqual([[`${authority}/postgres${query}`], [instance.url]]);
    expect(db.migrate).toHaveBeenCalledExactlyOnceWith(instance.pool);
    // Cleanup must use the original server, even if another caller changes env.
    vi.stubEnv('DATABASE_URL', 'postgres://other:other@elsewhere:5433/postgres');
    await instance.drop();
    expect(db.createPool).toHaveBeenLastCalledWith(`${authority}/postgres${query}`);
    expect(pools[2]!.query).toHaveBeenCalledExactlyOnceWith(`DROP DATABASE IF EXISTS "${instance.name}" WITH (FORCE)`);
    for (const pool of pools) expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('treats the env override as a prefix, never as a literal DROP target', async () => {
    vi.stubEnv(ENV, 'EXISTING_DB');
    const instance = await resetDb({ name: 'default_name', envVar: ENV, migrate: false });
    expect(instance.name).toMatch(/^existing_db_[a-f0-9]{32}$/);
    expect(db.migrate).not.toHaveBeenCalled();
    await instance.drop();
    const sql = pools.flatMap((pool) => pool.query.mock.calls.map(([sql]) => sql));
    expect(sql).toEqual([
      `CREATE DATABASE "${instance.name}"`,
      `DROP DATABASE IF EXISTS "${instance.name}" WITH (FORCE)`,
    ]);
  });

  it.each(['MiXeD', 'X'.repeat(500), '_Leading', 'select'])('normalizes prefix %s within 63 bytes', async (prefix) => {
    const instance = await resetDb({ name: prefix, migrate: false });
    expect(instance.name).toMatch(/^[a-z_][a-z0-9_]*_[a-f0-9]{32}$/);
    expect(instance.name.slice(0, -33)).toBe(prefix.toLowerCase().slice(0, 30));
    expect(Buffer.byteLength(instance.name)).toBeLessThanOrEqual(63);
    expect(new URL(instance.url).pathname).toBe(`/${instance.name}`);
    expect(pools[0]!.query).toHaveBeenCalledExactlyOnceWith(`CREATE DATABASE "${instance.name}"`);
    await instance.drop();
  });

  it.each(['', 'bad;name', 'bad-name', 'with space', '1name', '数据库', 'a"b', 'bad\0name'])(
    'rejects invalid prefix %j before acquiring resources', async (name) => {
      await expect(resetDb({ name })).rejects.toThrow('unsafe database name');
      expect(db.createPool).not.toHaveBeenCalled();
    },
  );
});

describe('resetDb resource lifecycle', () => {
  it('shares pending end/drop operations and performs each cleanup only once', async () => {
    const instance = await resetDb({ name: 'once' });
    let finish!: () => void;
    pools[1]!.end.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const end = instance.end();
    const drop = instance.drop();
    expect(instance.end()).toBe(end);
    expect(instance.drop()).toBe(drop);
    await Promise.resolve();
    expect(pools).toHaveLength(2); // DROP cannot race the pending pool close.
    finish();
    await Promise.all([end, drop]);
    await instance.end();
    await instance.drop();
    expect(pools).toHaveLength(3);
    for (const pool of pools) expect(pool.end).toHaveBeenCalledTimes(1);
    expect(pools[2]!.query).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('migration boom'), null, undefined, false, 0, ''])(
    'closes and drops after any migration failure (%s), preserving the primary value', async (error) => {
      db.migrate.mockRejectedValueOnce(error);
      await expect(resetDb({ name: 'migration_failure' })).rejects.toBe(error);
      expect(pools).toHaveLength(3);
      expect(pools[2]!.query.mock.calls[0]![0]).toBe(
        pools[0]!.query.mock.calls[0]![0].replace('CREATE DATABASE', 'DROP DATABASE IF EXISTS') + ' WITH (FORCE)',
      );
      for (const pool of pools) expect(pool.end).toHaveBeenCalledTimes(1);
    },
  );

  it('never drops an instance whose CREATE failed (including name collisions)', async () => {
    const admin = fakePool();
    const error = new Error('database already exists');
    admin.query.mockRejectedValueOnce(error);
    db.createPool.mockReturnValueOnce(admin);
    await expect(resetDb({ name: 'collision' })).rejects.toBe(error);
    expect(admin.query).toHaveBeenCalledTimes(1);
    expect(admin.query.mock.calls[0]![0]).toMatch(/^CREATE DATABASE/);
    expect(admin.end).toHaveBeenCalledTimes(1);
    expect(db.createPool).toHaveBeenCalledTimes(1);
    expect(db.migrate).not.toHaveBeenCalled();
  });

  it('keeps CREATE and admin-close errors without claiming ownership', async () => {
    const admin = fakePool();
    const primary = new Error('create failed');
    const cleanup = new Error('admin close failed');
    admin.query.mockRejectedValueOnce(primary);
    admin.end.mockRejectedValueOnce(cleanup);
    db.createPool.mockReturnValueOnce(admin);
    await expect(resetDb({ name: 'not_owned' })).rejects.toMatchObject({
      cause: primary, errors: [primary, cleanup],
    });
    expect(db.createPool).toHaveBeenCalledTimes(1);
    expect(admin.query).toHaveBeenCalledTimes(1);
  });

  it('drops a successful CREATE if closing its admin pool fails', async () => {
    const admin = fakePool();
    const error = new Error('admin close failed');
    admin.end.mockRejectedValueOnce(error);
    db.createPool.mockReturnValueOnce(admin);
    await expect(resetDb({ name: 'created' })).rejects.toBe(error);
    expect(pools[0]!.query.mock.calls[0]![0]).toMatch(/^DROP DATABASE/);
    expect(db.migrate).not.toHaveBeenCalled();
  });

  it('drops the created database if target pool construction throws', async () => {
    const error = new Error('invalid target pool');
    db.createPool.mockReturnValueOnce(fakePool()).mockImplementationOnce(() => { throw error; });
    await expect(resetDb({ name: 'target_failure' })).rejects.toBe(error);
    expect(pools[0]!.query.mock.calls[0]![0]).toMatch(/^DROP DATABASE/);
    expect(pools[0]!.end).toHaveBeenCalledTimes(1);
  });

  it('still drops when pool.end fails, and repeated end/drop retain the rejection', async () => {
    const instance = await resetDb({ name: 'close_failure' });
    const error = new Error('target close failed');
    pools[1]!.end.mockRejectedValueOnce(error);
    await expect(instance.end()).rejects.toBe(error);
    await expect(instance.drop()).rejects.toBe(error);
    await expect(instance.end()).rejects.toBe(error);
    await expect(instance.drop()).rejects.toBe(error);
    expect(pools[2]!.query).toHaveBeenCalledTimes(1);
    expect(pools[1]!.end).toHaveBeenCalledTimes(1);
    expect(pools).toHaveLength(3);
  });

  it('preserves migration, target-close, DROP and admin-close diagnostics', async () => {
    const primary = new Error('migration failed');
    const targetClose = new Error('target close failed');
    const drop = new Error('drop failed');
    const adminClose = new Error('admin close failed');
    const target = fakePool();
    const cleanupAdmin = fakePool();
    target.end.mockRejectedValueOnce(targetClose);
    cleanupAdmin.query.mockRejectedValueOnce(drop);
    cleanupAdmin.end.mockRejectedValueOnce(adminClose);
    db.createPool.mockReturnValueOnce(fakePool()).mockReturnValueOnce(target).mockReturnValueOnce(cleanupAdmin);
    db.migrate.mockRejectedValueOnce(primary);
    await expect(resetDb({ name: 'all_fail' })).rejects.toMatchObject({
      cause: primary,
      errors: [primary, { errors: [targetClose, { cause: drop, errors: [drop, adminClose] }] }],
    });
    expect(target.end).toHaveBeenCalledTimes(1);
    expect(cleanupAdmin.end).toHaveBeenCalledTimes(1);
  });

  it.each(['query', 'end'] as const)('reports cleanup admin %s failure on every drop call', async (operation) => {
    const instance = await resetDb({ name: 'cleanup_failure' });
    const admin = fakePool();
    const error = new Error(`cleanup ${operation} failed`);
    admin[operation].mockRejectedValueOnce(error);
    db.createPool.mockReturnValueOnce(admin);
    await expect(instance.drop()).rejects.toBe(error);
    await expect(instance.drop()).rejects.toBe(error);
    expect(admin.query).toHaveBeenCalledTimes(1);
    expect(admin.end).toHaveBeenCalledTimes(1);
  });
});
