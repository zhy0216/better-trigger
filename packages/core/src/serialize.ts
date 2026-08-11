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

   Canonical form, matching the replay-fingerprint serializer
   (packages/kernel/src/fingerprint.ts, C1): object keys are sorted
   recursively, so two values that differ only in key order serialize
   byte-identically and a jsonb round trip (Postgres reorders keys) changes
   nothing. The algorithm lives here, standalone — core must never depend on
   the kernel.
   ============================================================================= */
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

interface JsonObject {
  toJSON?: () => unknown;
}

/** Recursive canonicalization: keys sorted, toJSON honored (once per value),
 *  circular values rejected. Matches JSON.stringify's value semantics —
 *  undefined/function members are dropped in objects and become null in
 *  arrays; Date-like values go through toJSON first. */
function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (typeof (value as JsonObject).toJSON === 'function') {
    // toJSON is consulted exactly once, like JSON.stringify: its return value
    // is serialized as a plain value, never re-checked for toJSON — otherwise
    // { toJSON() { return this } } recurses forever (JSON.stringify yields
    // '{"a":1}' for that shape).
    return canonicalizePlain((value as JsonObject).toJSON?.(), seen);
  }
  return canonicalizePlain(value, seen);
}

function canonicalizePlain(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) {
    throw new TypeError('cannot serialize a circular structure');
  }
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) =>
      v === undefined || typeof v === 'function' ? null : canonicalize(v, seen),
    );
  } else {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || typeof v === 'function') continue;
      record[key] = canonicalize(v, seen);
    }
    out = record;
  }
  seen.delete(value);
  return out;
}

/** UTF-8 byte length. TextEncoder rather than Buffer: core is on the SDK's
 *  dependency path, and Buffer is not available in every runtime that imports
 *  the SDK. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
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
    const out = JSON.stringify(canonicalize(value, new WeakSet<object>()));
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
    // TypeError from the canonicalizer (circular structure) or from
    // JSON.stringify (BigInt, an exotic object). A stable error record, never
    // a raw throw — callers turn it into the KernelError the host maps to 4xx.
    const reason = err instanceof Error ? err.message : String(err);
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
