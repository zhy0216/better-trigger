/* =============================================================================
   @better-trigger/worker — business-pool sizing and deadline derivation.
   (todos/p1-11)

   The business pool is sized to the daemon's own work: concurrency claim
   loops plus headroom for everything else that draws on the same pool, and
   its deadlines are what turn a saturated pool or a hung query into a bounded
   error instead of a hang. This module is the single place that derivation
   lives, kept as a pure function so the defaults and the env overrides are
   unit-testable without importing the daemon entry (which would boot it).
   ============================================================================= */

/**
 * Headroom added to --concurrency for the business-pool max. Every checkout
 * on top of the concurrency claim loops is served from this budget: the
 * orchestrator loops (waits / cron / reaper / worker-offline), the heartbeat,
 * the waiter registry's sweep, and the HTTP routes' own queries. 8 covers one
 * of each with room to spare; the derivation exists so the pool is never
 * smaller than the daemon's own concurrency, which is what a saturated pool
 * (and therefore checkout timeouts) means.
 */
export const ORCHESTRATOR_HEADROOM = 8;

/** Default pool checkout/connect timeout in ms (0 = wait forever, pg's default). */
export const DEFAULT_POOL_CONNECT_TIMEOUT_MS = 10_000;

/** Default server-side statement timeout in ms (0 = off). */
export const DEFAULT_POOL_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * A non-negative-integer env knob with a fallback. Used for the pool timeouts:
 * 0 is valid there (connectionTimeoutMillis 0 = wait forever, statementTimeoutMs
 * 0 = off). A typo still fails at startup, since a silent fallback would change
 * the pool's timeout behaviour unnoticed.
 */
function parseEnvMs(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

/**
 * BETTER_TRIGGER_POOL_MAX: an explicit cap on the business pool, overriding the
 * derived max = concurrency + ORCHESTRATOR_HEADROOM. A positive integer only —
 * a pool with no connections could not serve anything, so 0 is refused like
 * any other unparseable value.
 */
function parsePoolMax(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`BETTER_TRIGGER_POOL_MAX must be a positive integer, got "${raw}"`);
  }
  return n;
}

/**
 * The business pool's sizing and deadline knobs, derived from the concurrency
 * the daemon will run and the pool env vars:
 *
 *   - max = concurrency + ORCHESTRATOR_HEADROOM, unless BETTER_TRIGGER_POOL_MAX
 *     sets an explicit cap (which wins over the derivation);
 *   - connectionTimeoutMillis defaults to 10000, overridable by
 *     BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS (0 = wait forever);
 *   - statementTimeoutMs defaults to 30000, overridable by
 *     BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS (0 = off).
 *
 * Garbage values throw rather than silently falling back: a pool sized by a
 * typo'd env is a pool that is wrong in exactly the way nobody noticed.
 */
export function derivePoolConfig(
  concurrency: number,
  env: Record<string, string | undefined>,
): { max: number; connectionTimeoutMillis: number; statementTimeoutMs: number } {
  return {
    max: parsePoolMax(env.BETTER_TRIGGER_POOL_MAX) ?? concurrency + ORCHESTRATOR_HEADROOM,
    connectionTimeoutMillis: parseEnvMs(
      'BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS',
      env.BETTER_TRIGGER_POOL_CONNECT_TIMEOUT_MS,
      DEFAULT_POOL_CONNECT_TIMEOUT_MS,
    ),
    statementTimeoutMs: parseEnvMs(
      'BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS',
      env.BETTER_TRIGGER_POOL_STATEMENT_TIMEOUT_MS,
      DEFAULT_POOL_STATEMENT_TIMEOUT_MS,
    ),
  };
}
