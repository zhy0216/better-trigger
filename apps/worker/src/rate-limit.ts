/* =============================================================================
   @better-trigger/worker — rate limiting (O6, todos/03-operability.md).

   Two rate-limit classes. The WRITE class covers the endpoints that
   create or control runs — POST /trigger, /batch-trigger, /runs/:id/cancel,
   /runs/:id/retry, and PATCH /schedules/:id (a control-plane write: enabling
   a schedule can launch a run) — token-bucket limited so that a hostile or
   misconfigured client cannot create runs without bound. The READ class
   covers everything else under /api/v1/ — GET /runs/:id/record,
   /runs/:id/result, /runs, /tasks, /schedules, /workers, /metrics, and any
   unknown /api/v1 path: each request can hit the DB (a /result long-poll is
   even a per-request query amplifier), so on a network-exposed daemon an
   unbounded read storm starves the claim/heartbeat loops on the shared
   business pool. /health, OPTIONS preflights and the dashboard's static
   assets (which live OUTSIDE /api/v1/) stay exempt.

   Two buckets are consumed per request in each class:

     - per key (`key:<bucket>:<keyFingerprint>`) — one noisy client cannot
       starve its neighbours;
     - per bucket (`global:<bucket>`) — even several keys together cannot
       drive the endpoint past the overall cap. Writes key the bucket by
       endpoint (`global:trigger`, …); reads share one `global:read`.

   The read bucket is deliberately LOOSE (defaults 200/s per key, 1000/s
   global): reads are far cheaper than a run-creating write, and a dashboard
   legitimately polls /tasks and /runs every few seconds — the read bucket
   only bounds an attack, it never throttles a dashboard. The write bucket
   stays strict.

   The dimensions NOT bucketed, deliberately: IP (unreliable behind a
   reverse proxy, which is the deployment this feature exists for —
   X-Forwarded-For is spoofable, and the socket address is the proxy's) and
   task (a task dimension adds nothing over the per-key cap: the caller is
   already keyed, and per-key already bounds what one caller can create).

   Buckets are in-memory and per-process. Several daemons behind a load
   balancer each keep their own buckets, so the cap is a backstop per
   process, not an exact fleet-wide meter — for an exact fleet-wide cap,
   put the limit at the reverse proxy (see README "Network exposure").

   Configuration (all read per request, so tests can flip them; 0 on a rate
   knob disables that dimension, 0 on BURST disables the whole limiter — no
   bucket is created or consumed on that path; negative or unparseable
   values fall back to the default):

     BETTER_TRIGGER_RATE_LIMIT_RPS              per-key write tokens/s  (default 50)
     BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS       per-endpoint write cap (default 200)
     BETTER_TRIGGER_RATE_LIMIT_READ_RPS         per-key read tokens/s   (default 200)
     BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS  read cap over all keys  (default 1000)
     BETTER_TRIGGER_RATE_LIMIT_BURST            bucket capacity/burst   (default = larger write rate; 0 disables the limiter)

   Over the limit the middleware throws KernelError('rate_limited') →
   429 `{ error: { code: 'rate_limited', message } }` via app.onError, and
   the audit middleware records it with reason 'rate_limited'.

   In-process embedded dispatches are exempt: the embedded runtime's fetch
   adapter marks its `Request` via `markInternalRequest` (internal-request.ts,
   a module-private WeakSet no network request can carry), and the middleware
   short-circuits on `isInternalRequest(c.req.raw)` before classifying the
   endpoint. The trust is narrow — only the exact Request the embedded adapter
   constructs — so the limiter still guards everything a host mounts `app`
   against; audit (outermost) and auth are untouched and still run for those
   calls. This is the P1-03 trade-off: trusted same-process traffic is not
   self-throttled, the external network surface is unchanged.

   A concurrency cap (max in-flight creations) was deliberately NOT added:
   a token bucket already bounds the creation rate, which is what the
   acceptance criterion ("cannot create runs without bound") asks for, and
   a second independent cap would only add configuration surface.
   ============================================================================= */
import type { MiddlewareHandler } from 'hono';
import { KernelError } from '@better-trigger/kernel';
import { isInternalRequest } from './internal-request';
import { remoteAddressOf, type AppVariables } from './middleware';

/** The run-affecting endpoints the rate limit guards. */
export type RateLimitedEndpoint = 'trigger' | 'batch-trigger' | 'retry' | 'cancel' | 'schedule';

/** Classify a request into its rate-limited endpoint, 'read' for the loose
 *  read bucket, or null for the exempt surface.
 *  The write endpoints keep their existing (POST-only) classification, plus
 *  PATCH /schedules/:id — a control-plane write, since enabling a schedule
 *  can launch a run. Everything else under /api/v1/ — GET /runs/:id/record,
 *  /runs/:id/result, /runs, /tasks, /schedules, /workers, /metrics and any
 *  unknown path, on any method — is a read: each one can hit the DB per
 *  request, so they all share the read bucket. /health and OPTIONS
 *  preflights stay exempt, and the dashboard's static assets never reach
 *  here (they live outside /api/v1/). */
export function endpointOf(method: string, path: string): RateLimitedEndpoint | 'read' | null {
  if (method === 'POST') {
    if (path === '/api/v1/trigger') return 'trigger';
    if (path === '/api/v1/batch-trigger') return 'batch-trigger';
    const match = /^\/api\/v1\/runs\/[^/]+\/(cancel|retry)$/.exec(path);
    if (match !== null) return match[1] as RateLimitedEndpoint;
  }
  if (method === 'PATCH' && /^\/api\/v1\/schedules\/[^/]+$/.test(path)) return 'schedule';
  if (method === 'OPTIONS' || path === '/api/v1/health') return null;
  if (path.startsWith('/api/v1/')) return 'read';
  return null;
}

export interface RateLimitConfig {
  /** Tokens per second per API key per write endpoint; 0 disables the per-key bucket. */
  rps: number;
  /** Tokens per second per write endpoint overall; 0 disables the global bucket. */
  globalRps: number;
  /** Tokens per second per API key across all reads; 0 disables the per-key bucket. */
  readRps: number;
  /** Tokens per second across all reads over all keys; 0 disables the global bucket. */
  readGlobalRps: number;
  /** Token bucket capacity (max burst), shared by all four dimensions;
   *  0 (explicitly set) disables the entire limiter. */
  burst: number;
}

const DEFAULT_RPS = 50;
const DEFAULT_GLOBAL_RPS = 200;
const DEFAULT_READ_RPS = 200;
const DEFAULT_READ_GLOBAL_RPS = 1000;

function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  // 0 is a valid "disable" value; anything negative or unparseable falls
  // back to the default (the same rule the request-limit envs use).
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

/** Rate-limit config from env; read per request (see the file header). */
export function rateLimitConfigFromEnv(env = process.env): RateLimitConfig {
  const rps = envInt(env.BETTER_TRIGGER_RATE_LIMIT_RPS, DEFAULT_RPS);
  const globalRps = envInt(env.BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS, DEFAULT_GLOBAL_RPS);
  const readRps = envInt(env.BETTER_TRIGGER_RATE_LIMIT_READ_RPS, DEFAULT_READ_RPS);
  const readGlobalRps = envInt(
    env.BETTER_TRIGGER_RATE_LIMIT_READ_GLOBAL_RPS,
    DEFAULT_READ_GLOBAL_RPS,
  );
  // A burst of 0 disables the whole limiter (see the middleware). The derived
  // default must not hit 0 just because both WRITE rates are 0 while the read
  // buckets are still active — a zero-capacity bucket would 429 every read.
  const writeMax = Math.max(rps, globalRps);
  const burst = envInt(
    env.BETTER_TRIGGER_RATE_LIMIT_BURST,
    writeMax > 0 ? writeMax : Math.max(readRps, readGlobalRps),
  );
  return { rps, globalRps, readRps, readGlobalRps, burst };
}

/** In-memory token buckets: each bucket holds up to `capacity` tokens and
 *  refills at `rate` tokens per second. The `now` clock is injectable so
 *  tests can drive refills deterministically. */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; refillAt: number }>();

  /**
   * Cap on distinct buckets before the least-recently-touched are evicted.
   * The per-key dimension is bounded by the number of API keys; the keyless
   * per-IP fallback (p2-31) is bounded by the distinct source addresses the
   * daemon sees — both tiny in practice, but a misconfigured proxy that
   * rotates source addresses must not grow this map without bound.
   */
  private static readonly MAX_ENTRIES = 4_096;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Refill by `now` and try to take one token from `key`; false = over the
   *  rate. The refill applies the rate/capacity passed on this call, so an
   *  env change takes effect on the bucket's next request. */
  consume(key: string, rate: number, capacity: number): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      // Fresh bucket: the first request takes the first token; a zero
      // capacity means even that is refused.
      if (this.buckets.size >= TokenBuckets.MAX_ENTRIES) {
        // Evict the earliest-INSERTED per-key bucket (Map preserves insertion
        // order; an existing key is mutated in place, never re-inserted, so the
        // front is the oldest). This is FIFO-by-insertion, not true LRU — fine
        // for a memory bound: an evicted bucket is re-created full-burst on its
        // next touch, so eviction can only ever be permissive. The `global:`
        // buckets are deliberately never evicted — resetting the fleet-wide
        // backstop to a fresh burst under a >4096-address flood would be a real
        // rate hole, not just memory churn.
        for (const oldest of this.buckets.keys()) {
          if (oldest.startsWith('key:')) {
            this.buckets.delete(oldest);
            break;
          }
        }
      }
      this.buckets.set(key, { tokens: Math.max(capacity - 1, 0), refillAt: now });
      return capacity > 0;
    }
    const elapsed = (now - bucket.refillAt) / 1000;
    if (elapsed > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * rate);
      bucket.refillAt = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Gate on the run-affecting write endpoints AND the read surface. Writes draw
 * from their per-endpoint buckets; reads draw from the shared `read` buckets.
 * Both buckets must have a token: the per-key one first (a misbehaving key is
 * the common case), then the global one. Anything else (the dashboard, /health,
 * OPTIONS) passes through untouched.
 */
export function rateLimitMiddleware(now?: () => number): MiddlewareHandler<{ Variables: AppVariables }> {
  const buckets = new TokenBuckets(now);
  return async (c, next) => {
    // In-process embedded dispatches carry a WeakSet marker (internal-request.ts)
    // that only this process could have written; they skip the limiter outright,
    // while the host-mounted external surface (unmarked) still draws buckets.
    // Audit/auth already ran in the outer layers and are unaffected.
    if (isInternalRequest(c.req.raw)) return next();
    const endpoint = endpointOf(c.req.method, c.req.path);
    if (endpoint === null) return next();
    const cfg = rateLimitConfigFromEnv();
    // `BURST=0` disables the entire limiter: short-circuit before the bucket
    // identity is even computed, so no per-key or global read/write bucket is
    // created or consumed on this path.
    if (cfg.burst === 0) return next();
    // Per-key identity: an authenticated key is its fingerprint; with no key
    // configured the per-key dimension falls back to the source address so one
    // local process exhausting the rate cannot starve its neighbours (p2-31).
    // The socket address is deliberately NOT spoofable via X-Forwarded-For.
    const ip = remoteAddressOf(c);
    const keyId = c.get('authKeyId') ?? (ip !== null ? `ip:${ip}` : 'anon');
    const read = endpoint === 'read';
    const bucket = read ? 'read' : endpoint;
    const rps = read ? cfg.readRps : cfg.rps;
    const globalRps = read ? cfg.readGlobalRps : cfg.globalRps;
    if (rps > 0 && !buckets.consume(`key:${bucket}:${keyId}`, rps, cfg.burst)) {
      throw new KernelError('rate_limited', `rate limit exceeded for ${endpoint}`);
    }
    if (globalRps > 0 && !buckets.consume(`global:${bucket}`, globalRps, cfg.burst)) {
      throw new KernelError('rate_limited', `rate limit exceeded for ${endpoint}`);
    }
    return next();
  };
}
