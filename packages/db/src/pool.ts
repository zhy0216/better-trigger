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

/**
 * Sizing and deadline knobs for the business pool. Plain `new Pool({
 * connectionString })` gives pg defaults of `max: 10`,
 * `connectionTimeoutMillis: 0` (a checkout waits forever) and no
 * `statement_timeout` — the three things a shared pool must bound:
 *
 *   - `max` caps pool saturation, so N claim loops can never queue unboundedly
 *     against the same budget the heartbeat, waiters and HTTP routes draw on.
 *   - `connectionTimeoutMillis` turns a black-holed or exhausted pool into a
 *     bounded checkout error instead of a forever-hanging `pool.connect()`.
 *   - `statementTimeoutMs` is sent as `statement_timeout` in the connection
 *     startup packet (same mechanism as createHealthPool), so PostgreSQL
 *     itself cancels a lock-waiting or hung query and returns the connection
 *     to the pool instead of letting it block a loop indefinitely.
 *
 * Any key left undefined is not passed to pg, so its default stands.
 */
export interface PoolOptions {
  /** Max clients (default: pg's 10). */
  max?: number;
  /** Connection checkout timeout in ms (default: 0 = wait forever, pg's default). */
  connectionTimeoutMillis?: number;
  /** Server-side statement timeout in ms, sent as `statement_timeout` in the
   *  startup packet (default: unset/off). */
  statementTimeoutMs?: number;
  /** Called for every pool-level 'error' event. Note this fires only for
   *  IDLE-CLIENT errors (a lost connection, an idle-in-transaction kill) —
   *  a checkout that times out does NOT emit it (pg-pool rejects the
   *  connect()/query() promise instead), so saturation is better observed on
   *  the connect/query rejections. */
  onError?: (err: Error) => void;
}

export function createPool(
  connectionString: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  logger: PoolLogger = console,
  opts: PoolOptions = {},
): pg.Pool {
  const poolOptions: pg.PoolConfig = { connectionString };
  if (opts.max !== undefined) poolOptions.max = opts.max;
  if (opts.connectionTimeoutMillis !== undefined) {
    poolOptions.connectionTimeoutMillis = opts.connectionTimeoutMillis;
  }
  if (opts.statementTimeoutMs !== undefined) {
    poolOptions.statement_timeout = opts.statementTimeoutMs;
  }
  const pool = new Pool(poolOptions);
  // pg emits 'error' on *idle* clients (Postgres restart, network drop,
  // idle_in_transaction_session_timeout, laptop sleep/wake). It is an
  // EventEmitter 'error' event: with no listener Node rethrows it as an
  // uncaught exception and the whole daemon dies. The pool discards the bad
  // client and opens a fresh one on its own, so recording it is the fix —
  // deliberately no process.exit here.
  pool.on('error', (err: Error) => {
    logger.error('[better-trigger] idle client error:', err.message);
    opts.onError?.(err);
  });
  return pool;
}

/* ---------------------------------------------------------------------------
   Probe pool (PF4, todos/02-performance.md) — a small dedicated pool for the
   /health?deep=1 and /metrics probes, so a hung or repeatedly-failing probe
   can never hold a business-pool connection. All three settings below are
   what make "the probe times out" different from "the probe leaks a
   connection":

     - max 2: a HEALTHCHECK and a Prometheus scrape can run at once, and that
       is the whole probe concurrency budget — probe connections are capped
       forever, whatever the business pool does.
     - statement_timeout 1000: node-postgres sends this as
       `-c statement_timeout=1000` in the connection startup packet, so
       PostgreSQL *itself* cancels a probe query after 1s and the connection
       returns to the pool. The routes' 2s Promise.race deadline is then only
       the HTTP answer, never the resource safety net — and it stays ahead of
       it, so the query fails (and frees its connection) before the response
       does.
     - connectionTimeoutMillis 1000: a black-holed network would otherwise
       leave the connect attempt in OS-land for minutes; at 1s the probe
       answers "query failed" instead.
   --------------------------------------------------------------------------- */

/** Probe concurrency ceiling: one HEALTHCHECK + one scrape, hard cap. */
const PROBE_POOL_MAX = 2;

/** Server-side query deadline on the probe pool, ms (must stay below the
 *  routes' 2s HTTP deadline). */
const PROBE_STATEMENT_TIMEOUT_MS = 1000;

/** Connection-establishment deadline on the probe pool, ms. */
const PROBE_CONNECT_TIMEOUT_MS = 1000;

export function createHealthPool(
  connectionString: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  logger: PoolLogger = console,
): pg.Pool {
  const pool = new Pool({
    connectionString,
    max: PROBE_POOL_MAX,
    statement_timeout: PROBE_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: PROBE_CONNECT_TIMEOUT_MS,
  });
  // Same idle-client contract as createPool: a probe pool that lost its
  // database must record it, not crash the daemon.
  pool.on('error', (err: Error) => {
    logger.error('[better-trigger] idle client error:', err.message);
  });
  return pool;
}
