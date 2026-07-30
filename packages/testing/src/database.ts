/* =============================================================================
   @better-trigger/testing — per-scenario database provisioning.

   Every acceptance scenario owns its own database, derived from DATABASE_URL by
   replacing the db name: DROP/CREATE against the <base>/postgres admin db, then
   (optionally) migrate. Scenarios are therefore order-independent and rerunnable
   without a manual cleanup step — which is the property the P2 fault-injection
   suite needs when it runs the same harness dozens of times.

   Env: DATABASE_URL supplies host/credentials only; its db name is ignored.
   ============================================================================= */
import { createPool, migrate } from '@better-trigger/db';
import type { Pool } from 'pg';

export const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/better_trigger';

/** Strip the database path off a postgres URL → protocol://user@host:port */
export function baseUrl(raw: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): string {
  const url = new URL(raw);
  url.pathname = '';
  return url.toString().replace(/\/+$/, '');
}

/** `<base>/<name>`, where base comes from DATABASE_URL. */
export function databaseUrlFor(name: string): string {
  return `${baseUrl()}/${name}`;
}

/** Read a numeric port from the environment, falling back to `fallback`. */
export function portFromEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  return raw ? Number(raw) : fallback;
}

export interface TestDatabase {
  /** Database name actually provisioned (after the env override). */
  name: string;
  /** Full connection string for the provisioned database. */
  url: string;
  /** Pool on the provisioned database, owned by the caller's scenario. */
  pool: Pool;
  /** Close the pool. Safe to call twice. */
  end(): Promise<void>;
  /** Close the pool and DROP the database (used by scenarios that clean up). */
  drop(): Promise<void>;
}

export interface ResetDbOptions {
  /** Default database name. */
  name: string;
  /** Env var that may override `name` (e.g. BT_CRASH_DB). */
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

async function withAdmin<T>(fn: (admin: Pool) => Promise<T>): Promise<T> {
  const admin = createPool(`${baseUrl()}/postgres`);
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/**
 * DROP + CREATE the scenario's database and hand back a pool on it. This is the
 * `resetDb()` every scenario starts with; it replaces the copy-pasted admin-pool
 * block each script used to carry.
 */
export async function resetDb(opts: ResetDbOptions): Promise<TestDatabase> {
  const name = (opts.envVar ? process.env[opts.envVar] : undefined) ?? opts.name;
  assertIdentifier(name);

  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  });

  const url = databaseUrlFor(name);
  const pool = createPool(url);
  if (opts.migrate ?? true) await migrate(pool);

  let ended = false;
  const end = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    await pool.end();
  };

  return {
    name,
    url,
    pool,
    end,
    async drop() {
      await end();
      await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
