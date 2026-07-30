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
   ============================================================================= */
import type { Context } from 'hono';
import { KernelError } from '@better-trigger/kernel';

/** Parse the request body as a JSON object; anything else → bad_request (400). */
export async function safeJson<T>(c: Context): Promise<T> {
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
 * anything that is not an integer >= `min` → bad_request (pg rejects a negative
 * or fractional LIMIT outright). Above `max` is capped rather than refused —
 * the cap is our protection, not part of the caller's contract.
 */
export function intQuery(
  c: Context,
  name: string,
  bounds: { min: number; max: number; fallback: number },
): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return bounds.fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < bounds.min) {
    throw new KernelError('bad_request', `${name} must be an integer >= ${bounds.min}`);
  }
  return Math.min(n, bounds.max);
}
