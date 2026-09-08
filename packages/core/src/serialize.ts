/* =============================================================================
   @better-trigger/core — safe JSON serialization (C3).

   One helper for every value that lands in a jsonb/text column or crosses the
   wire. Raw JSON.stringify throws a TypeError on a circular structure or a
   BigInt — at an API boundary that surfaces as a 500, and in the SDK it gets
   misread as a dead daemon. safeSerializeJson never throws: it returns either
   the serialized string (with its UTF-8 byte length — what pg measures and
   what every size cap is written against) or a stable failure record that
   names the field and carries a KernelErrorCode ('serialization_error' for a
   value JSON cannot represent, 'payload_too_large' for one that exceeds
   `maxBytes`).

   Canonical form for storage and replay fingerprints: object keys are sorted
   recursively, so two values that differ only in key order serialize
   byte-identically and a jsonb round trip (Postgres reorders keys) changes
   nothing. The algorithm lives here, standalone — core must never depend on
   the kernel.
   ============================================================================= */
import { serializeError } from './errors';
import type { KernelErrorCode } from './kernel-errors';

export interface SerializeOk {
  ok: true;
  /** The JSON string to store / send. */
  json: string;
  /** UTF-8 byte length of `json` — the number caps are compared against. */
  bytes: number;
}

export interface SerializeFailure {
  ok: false;
  /** serialization_error: the value is not JSON-serializable (circular
   *  structure, BigInt, top-level undefined/function/symbol).
   *  payload_too_large: it serialized fine but exceeded `maxBytes`. */
  code: Extract<KernelErrorCode, 'serialization_error' | 'payload_too_large'>;
  /** Human-readable reason, already naming `field`. */
  message: string;
  /** The field being serialized ('payload', 'output', 'error', 'data', …). */
  field: string;
  /** The value's actual UTF-8 byte length; present only on payload_too_large. */
  bytes?: number;
}

export type SerializeResult = SerializeOk | SerializeFailure;

/**
 * Shared canonical JSON bytes for storage and replay. Native JSON.stringify
 * first resolves getters, toJSON(key), boxed primitives, Dates and omissions
 * in native traversal order. Sorting only the resulting JSON tree avoids
 * invoking user hooks twice or recursively re-entering a self-returning hook.
 *
 * Like JSON.stringify, returns undefined for a root with no JSON spelling and
 * throws for BigInt, cycles or throwing hooks. Use safeSerializeJson at an
 * error boundary. Ordinary JSON keeps its existing bytes: array order stays
 * intact, integer-index keys precede other keys in numeric order, and other
 * object keys are sorted by UTF-16 code units. No input objects are mutated.
 */
export function canonicalStringify(value: unknown): string | undefined {
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  return JSON.stringify(canonicalizePlain(JSON.parse(json)));
}

/** Only receives a parsed JSON tree: no hooks, boxed values or cycles remain. */
function canonicalizePlain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(canonicalizePlain);
  }
  // A null prototype makes __proto__ an ordinary own data key, never a setter.
  const record: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    record[key] = canonicalizePlain((value as Record<string, unknown>)[key]);
  }
  return record;
}

/** UTF-8 byte length. TextEncoder rather than Buffer: core is on the SDK's
 *  dependency path, and Buffer is not available in every runtime that imports
 *  the SDK. The encoder is stateless, so one module-level instance is reused
 *  for every measurement instead of allocating one per call. */
const textEncoder = new TextEncoder();

function byteLength(s: string): number {
  return textEncoder.encode(s).length;
}

function fail(
  field: string,
  code: SerializeFailure['code'],
  message: string,
  bytes?: number,
): SerializeFailure {
  return bytes === undefined
    ? { ok: false, code, message, field }
    : { ok: false, code, message, field, bytes };
}

/**
 * Serialize a value for storage / transport without ever throwing.
 *
 * @param value    Anything the caller wants to persist or send.
 * @param maxBytes Optional cap on the serialized UTF-8 length. Absent means
 *                 no size limit (the SDK side — the daemon caps bodies at the
 *                 HTTP edge).
 * @param field    Human-readable name of the value, embedded in the failure
 *                 message so a bad_request surfaces which input was rejected.
 */
export function safeSerializeJson(
  value: unknown,
  maxBytes?: number,
  field = 'value',
): SerializeResult {
  let json: string;
  try {
    const out = canonicalStringify(value);
    if (out === undefined) {
      // JSON.stringify returns undefined for a top-level undefined/function/
      // symbol — a value that has no JSON spelling at all.
      return fail(
        field,
        'serialization_error',
        `${field} is not JSON-serializable (a top-level undefined, function or symbol)`,
      );
    }
    json = out;
  } catch (err) {
    // JSON.stringify rejects cycles / BigInt, and user hooks may throw any
    // value. Return a stable record; callers turn it into the KernelError
    // the host maps to 4xx. Diagnosing that thrown value must also be safe.
    const reason = serializeError(err).message;
    return fail(
      field,
      'serialization_error',
      `${field} is not JSON-serializable: ${reason}`,
    );
  }
  const bytes = byteLength(json);
  if (maxBytes !== undefined && bytes > maxBytes) {
    return fail(
      field,
      'payload_too_large',
      `${field} must serialize to at most ${maxBytes} bytes ` +
        `(store large objects elsewhere and pass a reference)`,
      bytes,
    );
  }
  return { ok: true, json, bytes };
}
