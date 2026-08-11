/* =============================================================================
   @better-trigger/worker — rate limiting (O6, todos/03-operability.md).

   The four endpoints that create or control runs — POST /trigger,
   /batch-trigger, /runs/:id/cancel, /runs/:id/retry — are token-bucket
   limited so that a hostile or misconfigured client cannot create runs
   without bound. Two buckets are consumed per request:

     - per key   (`key:<endpoint>:<keyFingerprint>`) — one noisy client
       cannot starve its neighbours;
     - per endpoint (`global:<endpoint>`) — even several keys together
       cannot drive the endpoint past the overall cap.

   The dimensions NOT bucketed, deliberately: IP (unreliable behind a
   reverse proxy, which is the deployment this feature exists for —
   X-Forwarded-For is spoofable, and the socket address is the proxy's) and
   task (a task dimension adds nothing over the per-key cap: the caller is
   already keyed, and per-key already bounds what one caller can create).

   Buckets are in-memory and per-process. Several daemons behind a load
   balancer each keep their own buckets, so the cap is a backstop per
   process, not an exact fleet-wide meter — for an exact fleet-wide cap,
   put the limit at the reverse proxy (see README "Network exposure").

   Configuration (all read per request, so tests can flip them; 0 disables
   that dimension; negative or unparseable values fall back to the default):

     BETTER_TRIGGER_RATE_LIMIT_RPS           per-key tokens/second   (default 50)
     BETTER_TRIGGER_RATE_LIMIT_GLOBAL_RPS    per-endpoint tokens/sec (default 200)
     BETTER_TRIGGER_RATE_LIMIT_BURST         bucket capacity/burst   (default = larger rate)

   Over the limit the middleware throws KernelError('rate_limited') →
   429 `{ error: { code: 'rate_limited', message } }` via app.onError, and
   the audit middleware records it with reason 'rate_limited'.

   A concurrency cap (max in-flight creations) was deliberately NOT added:
   a token bucket already bounds the creation rate, which is what the
   acceptance criterion ("cannot create runs without bound") asks for, and
   a second independent cap would only add configuration surface.
   ============================================================================= */
import type { MiddlewareHandler } from 'hono';
import { KernelError } from '@better-trigger/kernel';
import type { AppVariables } from './middleware';

/** The run-affecting endpoints the rate limit guards. */
export type RateLimitedEndpoint = 'trigger' | 'batch-trigger' | 'retry' | 'cancel';

/** Classify a request into its rate-limited endpoint, or null (reads, the
 *  dashboard, /health, OPTIONS — none of them create or control runs). */
export function endpointOf(method: string, path: string): RateLimitedEndpoint | null {
  if (method !== 'POST') return null;
  if (path === '/api/v1/trigger') return 'trigger';
  if (path === '/api/v1/batch-trigger') return 'batch-trigger';
  const match = /^\/api\/v1\/runs\/[^/]+\/(cancel|retry)$/.exec(path);
  if (match !== null) return match[1] as RateLimitedEndpoint;
  return null;
}

export interface RateLimitConfig {
  /** Tokens per second per API key per endpoint; 0 disables the per-key bucket. */
  rps: number;
  /** Tokens per second per endpoint overall; 0 disables the global bucket. */
  globalRps: number;
  /** Token bucket capacity (max burst), shared by both dimensions. */
  burst: number;
}

const DEFAULT_RPS = 50;
const DEFAULT_GLOBAL_RPS = 200;

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
  const burst = envInt(env.BETTER_TRIGGER_RATE_LIMIT_BURST, Math.max(rps, globalRps));
  return { rps, globalRps, burst };
}

/** In-memory token buckets: each bucket holds up to `capacity` tokens and
 *  refills at `rate` tokens per second. The `now` clock is injectable so
 *  tests can drive refills deterministically. */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; refillAt: number }>();

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
 * Gate on the four run-affecting endpoints. Both buckets must have a token:
 * the per-key one first (a misbehaving key is the common case), then the
 * global one. Anything else passes through untouched.
 */
export function rateLimitMiddleware(now?: () => number): MiddlewareHandler<{ Variables: AppVariables }> {
  const buckets = new TokenBuckets(now);
  return async (c, next) => {
    const endpoint = endpointOf(c.req.method, c.req.path);
    if (endpoint === null) return next();
    const cfg = rateLimitConfigFromEnv();
    const keyId = c.get('authKeyId') ?? 'anon';
    if (cfg.rps > 0 && !buckets.consume(`key:${endpoint}:${keyId}`, cfg.rps, cfg.burst)) {
      throw new KernelError('rate_limited', `rate limit exceeded for ${endpoint}`);
    }
    if (cfg.globalRps > 0 && !buckets.consume(`global:${endpoint}`, cfg.globalRps, cfg.burst)) {
      throw new KernelError('rate_limited', `rate limit exceeded for ${endpoint}`);
    }
    return next();
  };
}
