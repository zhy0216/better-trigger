/* =============================================================================
   @better-trigger/core — serializeError / isAbortError tests (01-core-sdk).

   serializeError is the total function the failure-reporting path depends on:
   it runs INSIDE the executor's error handling, so a raw JSON.stringify here
   would throw on a BigInt / circular value (crashing the report and mis-surfacing
   as a WorkerLostError) and would return `{ message: undefined }` for a value
   with no JSON spelling — violating SerializedError.message: string. Every input
   below must yield a string message and never throw. isAbortError must recognize
   the brand across realms, not just instanceof.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { AbortError, isAbortError, serializeError } from '../src/errors';

describe('serializeError — total on every thrown value', () => {
  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;

  const cases: Array<[string, unknown, string]> = [
    ['an Error subclass', new TypeError('bad type'), 'bad type'],
    ['a bare string', 'just a string', 'just a string'],
    ['a plain object', { a: 1 }, '{"a":1}'],
    ['a number', 42, '42'],
    ['null', null, 'null'],
    ['a BigInt (JSON.stringify throws)', 10n, 'non-serializable thrown value: 10'],
    ['a circular object (JSON.stringify throws)', circular, 'non-serializable thrown value: [object Object]'],
    ['undefined (no JSON spelling)', undefined, 'non-serializable thrown value: undefined'],
    ['a Symbol (no JSON spelling)', Symbol('sym'), 'non-serializable thrown value: Symbol(sym)'],
  ];

  for (const [label, input, expectedMessage] of cases) {
    it(`${label} → string message, never throws`, () => {
      let out: ReturnType<typeof serializeError> | undefined;
      expect(() => {
        out = serializeError(input);
      }).not.toThrow();
      expect(typeof out!.message).toBe('string');
      expect(out!.message).toBe(expectedMessage);
    });
  }

  it('a function → string message naming it (JSON.stringify returns undefined)', () => {
    const out = serializeError(function boom() {});
    expect(typeof out.message).toBe('string');
    expect(out.message).toMatch(/^non-serializable thrown value: function boom/);
  });

  it('an Error carries name + stack through', () => {
    const err = new Error('kaboom');
    const out = serializeError(err);
    expect(out.message).toBe('kaboom');
    expect(out.name).toBe('Error');
    expect(out.stack).toBe(err.stack);
  });

  it('preserves JSON from a null-prototype thrown value', () => {
    expect(serializeError(Object.assign(Object.create(null), { reason: 'bad' }))).toEqual({
      message: '{"reason":"bad"}',
    });
  });

  it.each(['message', 'name', 'stack'] as const)('isolates a throwing Error.%s getter', (key) => {
    const err = new Error('original message');
    // Materialize stack before overriding message/name: V8 may otherwise read
    // those properties lazily when formatting the stack itself.
    err.stack = 'original stack';
    const expected = { message: 'original message', name: 'Error', stack: 'original stack' };
    let reads = 0;
    Object.defineProperty(err, key, { get() { reads++; throw Object.create(null); } });
    const out = serializeError(err);
    expect(typeof out.message).toBe('string');
    expect(out[key]).toBe(key === 'message' ? 'unreadable error message' : undefined);
    for (const readable of ['message', 'name', 'stack'] as const) {
      if (readable !== key) expect(out[readable]).toBe(expected[readable]);
    }
    expect(reads).toBe(1);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('converts non-string Error fields to JSON-safe strings', () => {
    const err = new Error('original');
    Object.defineProperties(err, {
      message: { value: 42 }, name: { value: Symbol('kind') }, stack: { value: 10n },
    });
    expect(serializeError(err)).toEqual({ message: '42', name: 'Symbol(kind)', stack: '10' });
  });

  it('handles Error fields whose conversion throws or returns no primitive', () => {
    const err = new Error('original');
    Object.defineProperties(err, {
      message: { value: Object.create(null) },
      name: { value: { get toString() { throw new Error('no string'); } } },
      stack: { value: { [Symbol.toPrimitive]() { throw new Error('no primitive'); } } },
    });
    expect(serializeError(err)).toEqual({ message: 'unreadable error message', name: undefined, stack: undefined });
  });

  it('does not invoke Error toString/toJSON when its fields are readable', () => {
    const err = new TypeError('preserve me');
    const stack = err.stack;
    for (const key of ['toString', 'toJSON']) {
      Object.defineProperty(err, key, { get() { throw new Error('do not read'); } });
    }
    expect(serializeError(err)).toEqual({ message: 'preserve me', name: 'TypeError', stack });
  });

  it('retains a readable String fallback when a toJSON getter or method throws', () => {
    for (const value of [
      { get toJSON() { throw Object.create(null); }, toString: () => 'original detail' },
      { toJSON() { throw Object.create(null); }, toString: () => 'original detail' },
    ]) {
      expect(serializeError(value)).toEqual({ message: 'non-serializable thrown value: original detail' });
    }
  });

  it('retains readable JSON when toString is unusable', () => {
    const value = Object.defineProperty({ reason: 'original' }, 'toString', {
      get() { throw new Error('no string'); },
    });
    expect(serializeError(value)).toEqual({ message: '{"reason":"original"}' });
  });

  it('uses a stable fallback when both JSON and String conversion fail', () => {
    const nullPrototype = Object.assign(Object.create(null), { n: 1n });
    const circular = Object.create(null);
    circular.self = circular;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const cases = [
      nullPrototype, circular, revoked.proxy,
      { get toJSON() { throw nullPrototype; }, get toString() { throw nullPrototype; } },
      { toJSON() { throw nullPrototype; }, toString() { throw nullPrototype; } },
      { n: 1n, [Symbol.toPrimitive]() { throw nullPrototype; } },
      new Proxy({}, { getPrototypeOf() { throw nullPrototype; }, get() { throw nullPrototype; } }),
    ];
    for (const value of cases) {
      expect(serializeError(value)).toEqual({ message: 'non-serializable thrown value: [unprintable value]' });
    }
  });
});

describe('isAbortError — brand check survives realms', () => {
  it('recognizes a real AbortError', () => {
    expect(isAbortError(new AbortError('stop'))).toBe(true);
  });

  it('recognizes the brand on a non-instance (a duplicated core)', () => {
    const foreign = { isBetterTriggerAbort: true, message: 'stop' };
    expect(isAbortError(foreign)).toBe(true);
  });

  it('rejects unrelated values', () => {
    for (const err of [
      new Error('plain'),
      { isBetterTriggerAbort: false },
      {},
      null,
      undefined,
      'a string',
    ]) {
      expect(isAbortError(err)).toBe(false);
    }
  });
});
