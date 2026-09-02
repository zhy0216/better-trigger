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
