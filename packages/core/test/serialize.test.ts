/* =============================================================================
   @better-trigger/core — safeSerializeJson tests (C3).

   The helper must never throw: raw JSON.stringify blows up on a circular
   structure or a BigInt, and at an API boundary that reads as a 500 (or, in
   the SDK, as a dead daemon). Every failure mode returns a stable record with
   the code and the field name; every success returns the JSON plus its UTF-8
   byte length, which is what pg and every size cap measure.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { safeSerializeJson } from '../src/serialize';

describe('safeSerializeJson — success', () => {
  it('returns the JSON string and its UTF-8 byte length', () => {
    const res = safeSerializeJson({ a: 1 });
    expect(res).toEqual({ ok: true, json: '{"a":1}', bytes: 7 });
  });

  it('measures bytes, not characters', () => {
    const res = safeSerializeJson('中'.repeat(10));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The JSON spelling wraps the string in quotes: 10 chars × 3 UTF-8 bytes
    // + 2 quote bytes = 32 bytes for 12 JSON characters. A .length-based cap
    // would be wrong twice.
    expect(res.json.length).toBe(12);
    expect(res.bytes).toBe(32);
  });

  it('serializes two objects that differ only in key order identically', () => {
    const a = safeSerializeJson({ b: 2, a: { y: 1, x: 0 } });
    const b = safeSerializeJson({ a: { x: 0, y: 1 }, b: 2 });
    if (!a.ok || !b.ok) throw new Error('key-order test values must serialize');
    expect(a.json).toBe(b.json);
  });

  it('matches JSON.stringify value semantics (toJSON, undefined members, arrays)', () => {
    const date = safeSerializeJson({ d: new Date('2030-01-01T00:00:00.000Z') });
    if (!date.ok) throw new Error('date must serialize');
    expect(date.json).toBe('{"d":"2030-01-01T00:00:00.000Z"}');

    const dropped = safeSerializeJson({ a: undefined, b: 1 });
    if (!dropped.ok) throw new Error('undefined member must serialize');
    expect(dropped.json).toBe('{"b":1}');

    const arr = safeSerializeJson([undefined, () => {}, 1]);
    if (!arr.ok) throw new Error('array must serialize');
    expect(arr.json).toBe('[null,null,1]');
  });

  it('consults toJSON exactly once, like JSON.stringify — a self-returning toJSON does not recurse', () => {
    // Native JSON.stringify serializes { a:1, toJSON(){ return this } } as
    // '{"a":1}'; a serializer that re-invokes toJSON on the return value would
    // stack-overflow here and misreport serialization_error.
    const res = safeSerializeJson({ a: 1, toJSON() { return this; } });
    if (!res.ok) throw new Error('self-returning toJSON must serialize');
    expect(res.json).toBe('{"a":1}');
  });

  it('a top-level toJSON returning undefined is a serialization_error', () => {
    const res = safeSerializeJson({ toJSON: () => undefined });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('serialization_error');
  });
});

describe('safeSerializeJson — serialization_error', () => {
  it('rejects a circular structure with a stable error naming the field', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const res = safeSerializeJson(circular, undefined, 'payload');
    expect(res).toMatchObject({
      ok: false,
      code: 'serialization_error',
      field: 'payload',
    });
    if (!res.ok) expect(res.message).toContain('payload');
  });

  it('rejects a BigInt', () => {
    const res = safeSerializeJson({ n: 1n });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('serialization_error');
      expect(res.message).toContain('BigInt');
    }
  });

  it('rejects a top-level undefined, function and symbol', () => {
    for (const value of [undefined, () => {}, Symbol('x')]) {
      const res = safeSerializeJson(value, undefined, 'output');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('serialization_error');
    }
  });

  it('defaults the field name to "value"', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const res = safeSerializeJson(circular);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('value');
  });
});

describe('safeSerializeJson — payload_too_large', () => {
  it('rejects a value over maxBytes with code, field and measured bytes', () => {
    const res = safeSerializeJson('x'.repeat(100), 50, 'payload');
    expect(res).toMatchObject({
      ok: false,
      code: 'payload_too_large',
      field: 'payload',
      bytes: 102,
    });
    if (!res.ok) expect(res.message).toContain('at most 50 bytes');
  });

  it('accepts a value exactly at the cap', () => {
    const res = safeSerializeJson('x'.repeat(48), 50);
    expect(res.ok).toBe(true);
  });

  it('applies no limit when maxBytes is absent', () => {
    const res = safeSerializeJson('x'.repeat(1_000_000));
    expect(res.ok).toBe(true);
  });
});
