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
 * Any key left undefined is not passed to pg, so its default stands. Numeric
 * options must be safe integers; invalid types/ranges throw TypeError/RangeError
 * before a Pool is allocated. There is no additional business cap on max.
 */
export interface PoolOptions {
  /** Positive safe integer max clients (default: pg's 10). */
  max?: number;
  /** Integer ms in 0..2147483647 (default: 0 = wait forever, pg's default). */
  connectionTimeoutMillis?: number;
  /** Integer ms in 0..2147483647, sent as `statement_timeout` in the
   *  startup packet (default: unset/off). */
  statementTimeoutMs?: number;
  /** Called for every pool-level 'error' event. Note this fires only for
   *  IDLE-CLIENT errors (a lost connection, an idle-in-transaction kill) —
   *  a checkout that times out does NOT emit it (pg-pool rejects the
   *  connect()/query() promise instead), so saturation is better observed on
   *  the connect/query rejections. */
  onError?: (err: Error) => void;
}

function validatePoolNumber(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a safe integer between ${min} and ${max}`);
  }
}

export function createPool(
  connectionString: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  logger: PoolLogger = console,
  opts: PoolOptions = {},
): pg.Pool {
  // pg accepts configuration lazily and may coerce it (max: 0 becomes 10).
  // Fail before allocating the pool, including for direct embedded poolOptions.
  validatePoolNumber('max', opts.max, 1, Number.MAX_SAFE_INTEGER);
  // A connection deadline is a JS timer; statement_timeout is PostgreSQL's
  // signed 32-bit integer GUC in milliseconds. Both retain 0 = disabled.
  validatePoolNumber('connectionTimeoutMillis', opts.connectionTimeoutMillis, 0, 2_147_483_647);
  validatePoolNumber('statementTimeoutMs', opts.statementTimeoutMs, 0, 2_147_483_647);
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
   uses separate connections from the business pool:

     - max 2: a HEALTHCHECK and a Prometheus scrape can each borrow a client.
     - statement_timeout 1000: node-postgres sends this as
       `-c statement_timeout=1000` in the connection startup packet. This
       bounds SQL on a responsive server; it does not guarantee that the
       client observes cancellation before the routes' 2s HTTP deadline.
     - connectionTimeoutMillis 1000: bounds connection establishment and
       waiting for a checkout to 1s.

   Health and metrics each own one underlying checkout/query flight. At the
   HTTP deadline, the route destroys an in-flight query's client with
   release(true); a late checkout is returned without issuing a query. New
   requests share the failed result until the underlying promise settles.
   HTTP timeout and client destruction do not prove SQL cancellation: server
   work may continue during a network fault or with statement_timeout=0.
   --------------------------------------------------------------------------- */

/** Probe concurrency ceiling: one HEALTHCHECK + one scrape, hard cap. */
const PROBE_POOL_MAX = 2;

/** Server-side statement timeout, ms; independent of HTTP/client cleanup. */
const PROBE_STATEMENT_TIMEOUT_MS = 1000;

/** Connection-establishment deadline on the probe pool, ms. */
const PROBE_CONNECT_TIMEOUT_MS = 1000;

export function createHealthPool(
  connectionString: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  logger: PoolLogger = console,
): pg.Pool {
  return createPool(connectionString, logger, {
    max: PROBE_POOL_MAX,
    statementTimeoutMs: PROBE_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: PROBE_CONNECT_TIMEOUT_MS,
  });
}
