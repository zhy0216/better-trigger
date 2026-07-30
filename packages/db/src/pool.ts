/* =============================================================================
   @better-trigger/db — pg Pool factory.
   The package does not hold a connection itself; callers create (and own) the
   pool, which keeps the surface injectable for tests and embedded use.
   ============================================================================= */
import pg from 'pg';

const { Pool } = pg;

export const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/better_trigger';

/**
 * Sink for pool-level errors. Structurally satisfied by `console` and by the
 * kernel's `KernelLogger`, so a caller that already has one can pass it in.
 */
export interface PoolLogger {
  error(...args: unknown[]): void;
}

export function createPool(
  connectionString: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  logger: PoolLogger = console,
): pg.Pool {
  const pool = new Pool({ connectionString });
  // pg emits 'error' on *idle* clients (Postgres restart, network drop,
  // idle_in_transaction_session_timeout, laptop sleep/wake). It is an
  // EventEmitter 'error' event: with no listener Node rethrows it as an
  // uncaught exception and the whole daemon dies. The pool discards the bad
  // client and opens a fresh one on its own, so recording it is the fix —
  // deliberately no process.exit here.
  pool.on('error', (err: Error) => {
    logger.error('[better-trigger] idle client error:', err.message);
  });
  return pool;
}
