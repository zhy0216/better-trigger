/* =============================================================================
   @better-trigger/testing — per-scenario database provisioning.

   Every call creates a uniquely named database and owns only that instance.
   Parallel scenarios/checkouts can share a logical prefix without resetting
   each other's data or connections. Cleanup drops only a successful CREATE.

   Env: DATABASE_URL supplies connection settings; its db name is replaced.
   ============================================================================= */
import { createPool, migrate } from '@better-trigger/db';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

export const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/better_trigger';

/** Remove the database path and fragment, retaining connection parameters.
 *  Use databaseUrlFor to select a database; do not append a path after query. */
export function baseUrl(raw: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): string {
  const url = new URL(raw);
  url.pathname = '';
  url.hash = '';
  return url.toString();
}

/** Replace the database pathname without changing credentials/transport. */
export function databaseUrlFor(
  name: string,
  raw: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
): string {
  assertIdentifier(name);
  const url = new URL(baseUrl(raw));
  url.pathname = `/${name}`;
  return url.toString();
}

/** Read a numeric port from the environment, falling back to `fallback`. A
 *  present-but-garbage value throws naming the variable instead of silently
 *  becoming `--port NaN` on a daemon's command line. */
export function portFromEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${envVar} must be an integer TCP port, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/** An OS-assigned free port, released before the caller binds it. There is a
 *  small race (another process could grab it in between), which is exactly why
 *  the acceptance harnesses also honour explicit per-scenario port overrides —
 *  this is a convenient default, not a guarantee. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export interface TestDatabase {
  /** Actual lowercase database name, including the unique suffix. */
  name: string;
  /** Full connection string for the provisioned database. */
  url: string;
  /** Pool on the provisioned database, owned by the caller's scenario. */
  pool: Pool;
  /** Close the pool once. Repeated/concurrent calls share its result, even failure. */
  end(): Promise<void>;
  /** Close the pool and DROP only this instance, even if closing fails.
   *  Repeated/concurrent calls share the first cleanup result, even failure. */
  drop(): Promise<void>;
}

export interface ResetDbOptions {
  /** Logical prefix: ASCII identifier, lowercased and truncated to 30 bytes.
   *  A random 32-hex suffix makes the actual name unique and at most 63 bytes. */
  name: string;
  /** Env var overriding the logical prefix (e.g. BT_CRASH_DB), never a DROP target. */
  envVar?: string;
  /**
   * Apply migrations before returning. Default true. Pass false when the
   * scenario wants the daemon's own `--migrate` path to be the thing under
   * test (e2e does).
   */
  migrate?: boolean;
}

/** Postgres identifiers are interpolated, not bound — keep them boring. */
function assertIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe database name for a test scenario: ${JSON.stringify(name)}`);
  }
}

/** Preserve the original thrown value, attaching any secondary cleanup failure. */
async function failAfterCleanup(
  error: unknown,
  cleanup: () => Promise<void>,
  message: string,
): Promise<never> {
  const errors = [error];
  try {
    await cleanup();
  } catch (cleanupError) {
    errors.push(cleanupError);
  }
  if (errors.length === 1) throw error;
  throw new AggregateError(errors, message, { cause: error });
}

async function withAdmin<T>(url: string, fn: (admin: Pool) => Promise<T>): Promise<T> {
  const admin = createPool(url);
  let result: T;
  try {
    result = await fn(admin);
  } catch (error) {
    return failAfterCleanup(error, () => admin.end(), 'admin operation and pool cleanup failed');
  }
  await admin.end();
  return result;
}

/** CREATE a unique instance, optionally migrate, and return its owned handle. */
export async function resetDb(opts: ResetDbOptions): Promise<TestDatabase> {
  const prefix = (opts.envVar ? process.env[opts.envVar] : undefined) ?? opts.name;
  assertIdentifier(prefix);
  const name = `${prefix.toLowerCase().slice(0, 30)}_${randomUUID().replaceAll('-', '')}`;
  // Capture both URLs now: a later environment change must not redirect DROP.
  const raw = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const adminUrl = databaseUrlFor('postgres', raw);
  const url = databaseUrlFor(name, raw);
  let owned = false;
  let pool: Pool | undefined;
  let ending: Promise<void> | undefined;
  let dropping: Promise<void> | undefined;

  const end = (): Promise<void> => (ending ??= Promise.resolve().then(() => pool?.end()));
  const drop = (): Promise<void> => (dropping ??= (async () => {
    const errors: unknown[] = [];
    try {
      await end();
    } catch (error) {
      errors.push(error);
    }
    if (owned) {
      try {
        await withAdmin(adminUrl, async (admin) => {
          await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          owned = false;
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `database cleanup failed for ${name}`);
    }
  })());

  try {
    await withAdmin(adminUrl, async (admin) => {
      await admin.query(`CREATE DATABASE "${name}"`);
      owned = true;
    });
    pool = createPool(url);
    if (opts.migrate ?? true) await migrate(pool);
    return { name, url, pool, end, drop };
  } catch (error) {
    return failAfterCleanup(error, drop, `database provisioning and cleanup failed for ${name}`);
  }
}
