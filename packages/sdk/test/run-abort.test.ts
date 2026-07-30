/* =============================================================================
   better-trigger — the public ctx.signal abort surface.

   What user code actually touches when it honors ctx.signal: the reason object
   `fetch(url, { signal: ctx.signal })` rejects with, and the brand check that
   tells "this run was abandoned" apart from "my own call failed". Pure — no
   executor, no daemon; the wiring (who aborts when) lives in the worker's
   executor-signal / runtime tests.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { AbortError, isAbortError, isRunAborted, RunAbortedError } from '../src/index';
import type { RunAbortReason, RunCtx } from '../src/index';

const ALL_REASONS: RunAbortReason[] = ['canceled', 'shutting_down', 'lease_lost'];

describe('RunCtx.signal', () => {
  it('is a plain AbortSignal on the public type', () => {
    // Compile-time assertion (this package typechecks test/): both directions
    // only hold if ctx.signal is exposed publicly as an AbortSignal — i.e. a
    // user can store it, pass it to fetch, and keep their own types.
    const fromCtx: RunCtx['signal'] = new AbortController().signal;
    const asAbortSignal: AbortSignal = fromCtx;
    expect(asAbortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('RunAbortedError', () => {
  it('carries the reason and reads as an Error', () => {
    const err = new RunAbortedError('canceled');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RunAbortedError');
    expect(err.reason).toBe('canceled');
    expect(err.message).toBe('run aborted: canceled');
  });

  it('distinguishes all three abort reasons', () => {
    // The whole point of the discriminator: user code can log/branch on WHY the
    // run stopped mattering (a cancel is final; a drain will be replayed).
    for (const reason of ALL_REASONS) {
      const err = new RunAbortedError(reason);
      expect(err.reason).toBe(reason);
      expect(err.message).toContain(reason);
    }
  });
});

describe('isRunAborted', () => {
  it('recognizes its own instances, for every reason', () => {
    for (const reason of ALL_REASONS) expect(isRunAborted(new RunAbortedError(reason))).toBe(true);
  });

  it('recognizes a branded copy from a duplicate package instance', () => {
    // Same reasoning as core's isAbortError: two copies of better-trigger in one
    // process must not make `instanceof` the only test.
    expect(isRunAborted({ isBetterTriggerRunAborted: true, reason: 'canceled' })).toBe(true);
  });

  it('rejects everything else, including core AbortError', () => {
    // AbortError is thrown BY user code to fail a run without retries;
    // RunAbortedError is handed TO user code to stop work in flight. Neither
    // brand may answer for the other.
    expect(isRunAborted(new AbortError('do not retry'))).toBe(false);
    expect(isAbortError(new RunAbortedError('canceled'))).toBe(false);
    expect(isRunAborted(new Error('boom'))).toBe(false);
    expect(isRunAborted('canceled')).toBe(false);
    expect(isRunAborted({ reason: 'canceled' })).toBe(false);
    expect(isRunAborted(undefined)).toBe(false);
    expect(isRunAborted(null)).toBe(false);
  });
});
