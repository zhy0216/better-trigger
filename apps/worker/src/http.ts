/* =============================================================================
   @better-trigger/worker — HTTP request helpers.
   safeJson(c) stands in for `c.req.json<T>()` on every body-reading route: a
   body that is not a JSON object (malformed, empty, or a bare scalar) is the
   caller's mistake, so it must surface as KernelError('bad_request') → 400 via
   app.onError — not as a raw SyntaxError → 500 plus an "unhandled error" log.
   requireBoolean / intQuery apply the same rule one level down, to the fields
   read off a body or query string: a value with the wrong type must never reach
   pg (where it lands as a NOT NULL violation or an `invalid input syntax`
   error, i.e. a 500 blaming the server for the client's typo).
   safeJson also insists on `Content-Type: application/json` — see below, that
   one is the CORS allowlist's other half rather than a validation nicety.
   ============================================================================= */
import type { Context } from 'hono';
import { KernelError } from '@better-trigger/kernel';

/**
 * Refuse a body that is not announced as JSON.
 *
 * This is a security check, not politeness. CORS only ever gets a say when the
 * browser sends a preflight, and a cross-origin POST is a *simple request* —
 * no preflight at all — as long as its Content-Type is `text/plain`,
 * `application/x-www-form-urlencoded` or `multipart/form-data`. So any page the
 * user visits can POST JSON *text* to http://localhost:4848/api/v1/trigger
 * under `text/plain`: the browser withholds the response (no
 * Access-Control-Allow-Origin), but the request has already arrived and the
 * task has already run. Requiring application/json takes the shape away —
 * asking for that Content-Type forces a preflight, and the preflight is where
 * middleware.ts's allowedOrigin() refuses.
 *
 * Callers that send no Origin (the SDK, curl, the dashboard) already send
 * application/json, so nothing legitimate changes. Rejected as `bad_request`
 * (400) rather than 415 to keep one error family on the wire.
 */
function requireJsonContentType(c: Context): void {
  // `application/json; charset=utf-8` is the same media type as the bare form;
  // the parameters after the `;` are not ours to police.
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    throw new KernelError('bad_request', 'Content-Type must be application/json');
  }
}

/** Parse the request body as a JSON object; anything else → bad_request (400). */
export async function safeJson<T>(c: Context): Promise<T> {
  requireJsonContentType(c);
  let parsed: unknown;
  try {
    parsed = await c.req.json<unknown>();
  } catch {
    // Malformed JSON and an empty body both land here (json() is JSON.parse).
    throw new KernelError('bad_request', 'request body must be valid JSON');
  }
  // Every request shape we accept is an object; a scalar / null / array would
  // only blow up further in as a TypeError (→ 500) on the first field read
  // — or, worse, quietly reach the kernel as an all-undefined body.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KernelError('bad_request', 'request body must be a JSON object');
  }
  return parsed as T;
}

/** Require a boolean body field; missing / wrong-typed → bad_request (400). */
export function requireBoolean(value: unknown, field: string): boolean {
  // `{}` would otherwise pass `undefined` to pg → NULL → NOT NULL violation.
  if (typeof value !== 'boolean') {
    throw new KernelError('bad_request', `${field} must be a boolean`);
  }
  return value;
}

/**
 * Read a numeric query param destined for SQL. Absent / empty → `fallback`;
 * anything that is not an integer >= `min` is either refused (bad_request, the
 * default — pg rejects a negative or fractional LIMIT outright) or, with
 * `onInvalid: 'clamp'`, silently clamped to the bounds. Above `max` is capped
 * rather than refused either way — the cap is our protection, not part of the
 * caller's contract. Two callers are allowed to differ on GARBAGE INPUT
 * handling (`?timeoutMs=abc` is a tolerance thing, `?limit=abc` is a caller
 * bug) — but every numeric query param in the API resolves through this one
 * function so the choice is explicit at the call site (p2-32).
 */
export function intQuery(
  c: Context,
  name: string,
  bounds: { min: number; max: number; fallback: number },
  opts: { onInvalid?: 'throw' | 'clamp' } = {},
): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return bounds.fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < bounds.min) {
    if (opts.onInvalid === 'clamp') {
      // Tolerated, not refused: a below-min integer clamps up to min (the
      // above-max case is capped by the Math.min below either way), and only
      // garbage that parses to no integer keeps the fallback.
      return Number.isSafeInteger(n) ? bounds.min : bounds.fallback;
    }
    throw new KernelError('bad_request', `${name} must be an integer >= ${bounds.min}`);
  }
  return Math.min(n, bounds.max);
}
