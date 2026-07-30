/* =============================================================================
   @better-trigger/worker — middleware.
   Bearer auth (skipped when BETTER_TRIGGER_API_KEY is unset; /health always
   open; the key is compared in constant time) + a loopback-only CORS
   allowlist.

   The API is unauthenticated by default, so the browser is an entry path of its
   own: with `origin: '*'` any page the user visits could POST /api/v1/trigger
   at http://localhost:4848 and read back run payloads. Only the dashboard's own
   origins are allowed by default — http/https on localhost / 127.0.0.0/8 /
   [::1], any port (the dev vite port is not fixed) — and anything else is
   answered without the Access-Control-Allow-Origin header, which is what makes
   the browser drop the response. `--cors-origin` (env
   BETTER_TRIGGER_CORS_ORIGIN) opens that up explicitly.

   Non-browser callers (the SDK, curl) send no Origin and are untouched: CORS
   only ever decides what a *browser* hands back to a page.
   ============================================================================= */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

/** Origins allowed on top of loopback, from `--cors-origin`. */
let configuredOrigins: string[] = [];

/**
 * Extra allowed origins, from `--cors-origin`. Called by main.ts before
 * createApp; BETTER_TRIGGER_CORS_ORIGIN is honoured either way, so an embedded
 * createApp() that never calls this still gets the env.
 */
export function setCorsOrigins(origins: string[]): void {
  configuredOrigins = parseOriginList(origins.join(','));
}

/** Splits `a,b` / repeated flags into normalized origins ('*' passes through). */
export function parseOriginList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === '*' ? s : normalizeOrigin(s) ?? s));
}

/** `http://Host:3000/path` → `http://host:3000`; null when it is not a URL. */
function normalizeOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

/**
 * Loopback origins only, parsed rather than pattern-matched: `new URL` is what
 * decides where the host ends, so `http://localhost.evil.com` (host
 * localhost.evil.com) and `http://localhost@evil.com` (host evil.com) are both
 * misses instead of substring hits.
 */
function isLoopbackOrigin(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false; // "null" (file://, sandboxed iframe) lands here too.
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // hostname is the host without the port; IPv6 literals keep their brackets.
  // No IPv4-mapped form here: `new URL` rewrites [::ffff:127.0.0.1] to its hex
  // spelling [::ffff:7f00:1], and no browser puts either in an Origin anyway.
  const host = url.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Configured origins plus the env, which is read here and only here — the CLI
 * hands over `--cors-origin` alone, so listing an origin in both places cannot
 * duplicate it.
 */
function extraOrigins(): string[] {
  const fromEnv = parseOriginList(process.env.BETTER_TRIGGER_CORS_ORIGIN ?? '');
  return fromEnv.length > 0 ? [...configuredOrigins, ...fromEnv] : configuredOrigins;
}

/** The origin allowed back to the caller, or null to send no CORS header. */
export function allowedOrigin(origin: string): string | null {
  if (!origin) return null; // Same-origin GETs and non-browser clients.
  const extra = extraOrigins();
  if (extra.includes('*')) return origin;
  if (isLoopbackOrigin(origin)) return origin;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && extra.includes(normalized) ? origin : null;
}

export const corsMiddleware: MiddlewareHandler = cors({
  origin: (origin) => allowedOrigin(origin),
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
});

/**
 * Constant-time token compare. `===` stops at the first differing byte, so the
 * time it takes tells a caller how much of the key it guessed right — feed it
 * enough requests and the key falls out one byte at a time. timingSafeEqual
 * throws when the lengths differ, hence the length check first; the length
 * itself leaks, which is the standard trade (it is not the secret).
 */
function tokenMatches(token: string, apiKey: string): boolean {
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(apiKey, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Bearer auth. No-op when the env key is unset. /api/v1/health is always open. */
export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const apiKey = process.env.BETTER_TRIGGER_API_KEY;
    if (!apiKey) return next();

    const path = c.req.path;
    if (path === '/api/v1/health') return next();

    const header = c.req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!tokenMatches(token, apiKey)) {
      return c.json(
        { error: { code: 'unauthorized', message: 'invalid or missing API key' } },
        401,
      );
    }
    return next();
  };
}
