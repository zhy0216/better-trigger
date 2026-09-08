/* =============================================================================
   @better-trigger/core — safeSerializeJson tests (C3).

   The helper must never throw: raw JSON.stringify blows up on a circular
   structure or a BigInt, and at an API boundary that reads as a 500 (or, in
   the SDK, as a dead daemon). Every failure mode returns a stable record with
   the code and the field name; every success returns the JSON plus its UTF-8
   byte length, which is what pg and every size cap measure.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { canonicalStringify, safeSerializeJson } from '../src/index';

// Ordinary JSON golden vectors shared with the replay serializer (todo 03).
// Integer-index keys retain JSON.stringify's numeric ordering; other keys use
// UTF-16 code-unit ordering. These bytes predate the F2–F4 fixes.
const goldenVectors: Array<[string, unknown, string]> = [
  ['null', null, 'null'],
  ['primitive', '中😀', '"中😀"'],
  ['empty containers', { z: [], a: {} }, '{"a":{},"z":[]}'],
  ['nested objects', { b: 2, a: { y: 1, x: 0 } }, '{"a":{"x":0,"y":1},"b":2}'],
  ['array order', [{ z: 3, a: 1 }, null, [true, false, 'x']], '[{"a":1,"z":3},null,[true,false,"x"]]'],
  ['numeric keys', { '10': 'ten', '2': 'two', b: 2, '01': 'one', a: 1 }, '{"2":"two","10":"ten","01":"one","a":1,"b":2}'],
  ['escaping', { z: '\n"\\', a: '\ud800' }, '{"a":"\\ud800","z":"\\n\\"\\\\"}'],
  ['fingerprint envelope', { v: 1, kind: 'step', label: 'fetch', input: { z: [3, { y: 2, a: 1 }], a: true }, code: null }, '{"code":null,"input":{"a":true,"z":[3,{"a":1,"y":2}]},"kind":"step","label":"fetch","v":1}'],
];

describe('safeSerializeJson — ordinary JSON golden vectors', () => {
  it.each(goldenVectors)('%s keeps its canonical bytes', (_label, value, json) => {
    expect(canonicalStringify(value)).toBe(json);
    expect(safeSerializeJson(value)).toEqual({
      ok: true, json, bytes: new TextEncoder().encode(json).length,
    });
  });
});

describe('canonicalStringify — shared throwing API', () => {
  it('returns undefined for root values without a JSON spelling', () => {
    for (const value of [undefined, () => {}, Symbol('x'), { toJSON: () => undefined }]) {
      expect(canonicalStringify(value)).toBeUndefined();
    }
  });

  it('rejects cycles and BigInt instead of producing a valid JSON marker', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const value of [cycle, 1n, Object(1n)]) {
      expect(() => canonicalStringify(value)).toThrow(TypeError);
    }
  });

  it('propagates the original hook failure for the caller to diagnose', () => {
    const thrown = Object.create(null);
    let caught: unknown;
    try {
      canonicalStringify({ toJSON() { throw thrown; } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(thrown);
  });
});

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

  it('preserves own special keys without changing input or output prototypes', () => {
    const value = JSON.parse('{"z":0,"__proto__":{"z":1,"a":2},"constructor":{"prototype":{"keep":true}},"prototype":3,"toString":4,"a":[{"__proto__":null}]}');
    const before = JSON.stringify(value);
    const res = safeSerializeJson(value);
    expect(res).toMatchObject({
      ok: true,
      json: '{"__proto__":{"a":2,"z":1},"a":[{"__proto__":null}],"constructor":{"prototype":{"keep":true}},"prototype":3,"toString":4,"z":0}',
    });
    if (!res.ok) throw new Error('special keys must serialize');
    const parsed = JSON.parse(res.json);
    expect(parsed).toEqual(value);
    for (const object of [value, parsed, value.a[0], parsed.a[0]]) {
      expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
      expect(Object.hasOwn(object, '__proto__')).toBe(true);
    }
    expect(JSON.stringify(value)).toBe(before);
    expect(Object.hasOwn(Object.prototype, 'keep')).toBe(false);
  });

  it.each([
    ['Number', new Number(7), '7'],
    ['String', new String('ok'), '"ok"'],
    ['Boolean', new Boolean(false), 'false'],
    ['non-finite Number', new Number(NaN), 'null'],
  ])('unboxes %s at the root, in objects and in arrays', (_label, value, json) => {
    expect(safeSerializeJson(value)).toMatchObject({ ok: true, json });
    expect(safeSerializeJson({ z: value })).toMatchObject({ ok: true, json: `{"z":${json}}` });
    expect(safeSerializeJson([value])).toMatchObject({ ok: true, json: `[${json}]` });
  });

  it('uses native boxed coercion, including Boolean internal slots and toJSON first', () => {
    const number = Object.assign(new Number(7), { valueOf: () => 9 });
    const string = Object.assign(new String('ok'), { toString: () => 'changed' });
    const boolean = Object.assign(new Boolean(false), { valueOf: () => true });
    const customized = Object.assign(new Number(7), { toJSON: () => ({ z: 2, a: 1 }) });
    expect(safeSerializeJson([number, string, boolean, customized])).toMatchObject({
      ok: true, json: '[9,"changed",false,{"a":1,"z":2}]',
    });
  });

  it('passes the root, property and array keys with the original receiver', () => {
    const calls: string[] = [];
    const value = {
      toJSON(key: string) {
        expect(this).toBe(value);
        calls.push(key);
        return { z: key, a: 1 };
      },
    };
    expect(safeSerializeJson(value)).toMatchObject({ ok: true, json: '{"a":1,"z":""}' });
    expect(safeSerializeJson({ property: value })).toMatchObject({ ok: true, json: '{"property":{"a":1,"z":"property"}}' });
    expect(safeSerializeJson([value])).toMatchObject({ ok: true, json: '[{"a":1,"z":"0"}]' });
    expect(calls).toEqual(['', 'property', '0']);
  });

  it('evaluates user getters in native order before sorting their JSON results', () => {
    const calls: string[] = [];
    const value = {
      get z() { calls.push('z'); return { toJSON(key: string) { calls.push(key); return calls.length; } }; },
      get a() { calls.push('a'); return calls.length; },
    };
    expect(safeSerializeJson(value)).toMatchObject({ ok: true, json: '{"a":3,"z":2}' });
    expect(calls).toEqual(['z', 'z', 'a']);
  });

  it('reads a non-enumerable toJSON getter once and permits shared self-returning values', () => {
    let reads = 0;
    const calls: string[] = [];
    const value = { z: 2, a: 1 };
    Object.defineProperty(value, 'toJSON', {
      get() {
        reads++;
        return function (this: unknown, key: string) { calls.push(key); return this; };
      },
    });
    expect(safeSerializeJson({ left: value, right: [value] })).toMatchObject({
      ok: true, json: '{"left":{"a":1,"z":2},"right":[{"a":1,"z":2}]}',
    });
    expect(reads).toBe(2);
    expect(calls).toEqual(['left', '0']);
  });

  it('does not consult toJSON again on the returned object', () => {
    let calls = 0;
    const result = { z: 2, a: 1, toJSON() { calls++; throw new Error('must not be called'); } };
    expect(safeSerializeJson({ toJSON: () => result })).toMatchObject({ ok: true, json: '{"a":1,"z":2}' });
    expect(calls).toBe(0);
    expect(safeSerializeJson({ toJSON: () => new Number(7) })).toMatchObject({ ok: true, json: '7' });
  });

  it('honors toJSON on functions, including object and array members', () => {
    const fn = Object.assign(() => {}, { toJSON: (key: string) => key });
    expect(safeSerializeJson(fn)).toMatchObject({ ok: true, json: '""' });
    expect(safeSerializeJson({ fn })).toMatchObject({ ok: true, json: '{"fn":"fn"}' });
    expect(safeSerializeJson([fn])).toMatchObject({ ok: true, json: '["0"]' });
  });

  it('handles Dates, invalid Dates and array toJSON', () => {
    expect(safeSerializeJson(new Date('2030-01-01T00:00:00.000Z'))).toMatchObject({ ok: true, json: '"2030-01-01T00:00:00.000Z"' });
    expect(safeSerializeJson([new Date(NaN)])).toMatchObject({ ok: true, json: '[null]' });
    const array = Object.assign([1, 2], { toJSON: (key: string) => ({ z: key, a: true }) });
    expect(safeSerializeJson({ array })).toMatchObject({ ok: true, json: '{"array":{"a":true,"z":"array"}}' });
  });

  it('uses array positions, ignoring map overrides and non-index members', () => {
    const value = Object.assign([1, undefined, undefined, Symbol('x'), () => {}], {
      map() { throw new Error('not a JSON hook'); }, extra: 1n,
    });
    delete value[1];
    expect(safeSerializeJson(value)).toMatchObject({ ok: true, json: '[1,null,null,null,null]' });
  });

  it('preserves native omission, non-finite numbers, symbol keys and toJSON results', () => {
    const omitted = { toJSON: () => undefined };
    const value = { z: omitted, a: [omitted, NaN, Infinity, -Infinity, -0], fn: () => {}, symbol: Symbol('x'), [Symbol('key')]: 1n };
    expect(safeSerializeJson(value)).toMatchObject({ ok: true, json: '{"a":[null,null,null,null,0]}' });
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

  it('rejects primitive and boxed BigInt in every JSON position', () => {
    for (const value of [1n, Object(1n)]) {
      for (const input of [value, { value }, [value], { toJSON: () => value }]) {
        expect(safeSerializeJson(input)).toMatchObject({ ok: false, code: 'serialization_error', message: expect.any(String) });
      }
    }
  });

  it('rejects array cycles and cycles after self-returning toJSON', () => {
    const array: unknown[] = [];
    array.push(array);
    const object: Record<string, unknown> = { toJSON() { return this; } };
    object.self = object;
    for (const value of [array, object]) {
      expect(safeSerializeJson(value)).toMatchObject({ ok: false, code: 'serialization_error', message: expect.any(String) });
    }
  });

  it('keeps readable diagnostics from throwing getters and toJSON methods', () => {
    for (const value of [
      { get toJSON() { throw new TypeError('hook unavailable'); } },
      { toJSON() { throw new TypeError('hook unavailable'); } },
      { get value() { throw new TypeError('hook unavailable'); } },
    ]) {
      expect(safeSerializeJson(value, undefined, 'payload')).toEqual({
        ok: false, code: 'serialization_error', field: 'payload',
        message: 'payload is not JSON-serializable: hook unavailable',
      });
    }
  });

  it('never throws while diagnosing hostile thrown values', () => {
    const nullPrototype = Object.assign(Object.create(null), { n: 1n });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const unreadable = {
      get toJSON() { throw nullPrototype; },
      get toString() { throw nullPrototype; },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const errors = ['message', 'name', 'stack'].map((key) => {
      const err = new Error('original message');
      Object.defineProperty(err, key, { get() { throw nullPrototype; } });
      return err;
    });
    for (const thrown of [Object.create(null), nullPrototype, unreadable, circular, 1n, revoked.proxy, ...errors]) {
      const value = { toJSON() { throw thrown; } };
      let res: ReturnType<typeof safeSerializeJson> | undefined;
      expect(() => { res = safeSerializeJson(value, undefined, 'output'); }).not.toThrow();
      expect(res).toMatchObject({ ok: false, code: 'serialization_error', field: 'output', message: expect.any(String) });
    }
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

  it('enforces Unicode byte caps after conversion and canonicalization', () => {
    const value = { toJSON: () => ({ z: '😀', a: '中' }) };
    expect(safeSerializeJson(value, 22)).toEqual({ ok: true, json: '{"a":"中","z":"😀"}', bytes: 22 });
    expect(safeSerializeJson(value, 21, 'output')).toMatchObject({ ok: false, code: 'payload_too_large', field: 'output', bytes: 22 });
  });
});
