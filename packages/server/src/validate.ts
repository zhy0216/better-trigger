/* =============================================================================
   @better-trigger/server — minimal request-shape validation helpers.
   Small guards used by routes to reject malformed bodies with a 400 instead of
   letting them blow up deeper (500). Throws HttpError(400, 'bad_request', ...).
   ============================================================================= */
import { HttpError } from './engine/runs';

/** Max number of log entries accepted per /runs/:id/logs request. */
export const MAX_LOGS_PER_REQUEST = 5000;

function bad(message: string): never {
  throw new HttpError(400, 'bad_request', message);
}

/** Assert a value is a JSON object (not null, not an array). */
export function assertObject(v: unknown, what: string): asserts v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    bad(`${what} must be an object`);
  }
}

/** Assert a value is an array. */
export function assertArray(v: unknown, what: string): asserts v is unknown[] {
  if (!Array.isArray(v)) bad(`${what} must be an array`);
}

/** Assert a value is a non-empty string. */
export function assertString(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) bad(`${what} must be a non-empty string`);
}

/**
 * Validate an optional priority: when present it must be an int32 so it fits the
 * `queue.priority int4` column (raw values like 3e9 / 1.5 / 1e20 would 500 in pg).
 */
export function validatePriority(priority: unknown): void {
  if (priority == null) return;
  if (
    typeof priority !== 'number' ||
    !Number.isSafeInteger(priority) ||
    priority < -2147483648 ||
    priority > 2147483647
  ) {
    bad('priority must be an int32');
  }
}
