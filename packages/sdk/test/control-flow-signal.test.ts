/* =============================================================================
   better-trigger — the public rethrow predicate (todos/01-correctness.md C6).

   The runtime throws two different values through user code to steer it: the
   suspend signal and the end-of-execution signal. The docs and the runtime's
   own AbortError both tell users to write

       catch (err) { if (isControlFlowSignal(err)) throw err; ... }

   so that advice has to actually cover BOTH — a predicate that only knew about
   suspend would leave the step-failure path swallowing its signal exactly as
   before. Pure: the class producing the second signal lives in the worker
   (ExecutionDone), which is why only its brand is checked here.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import {
  AbortError,
  isControlFlowSignal,
  isSuspendSignal,
  SuspendSignal,
} from '../src/index';
import type { ExecutionEndedSignal } from '../src/index';

/** Shaped exactly like the worker's private ExecutionDone (executor.ts). */
function executionEnded(): ExecutionEndedSignal {
  const err = new Error('execution complete') as Error & {
    isBetterTriggerExecutionDone: true;
  };
  err.name = 'ExecutionDone';
  err.isBetterTriggerExecutionDone = true;
  return err;
}

const SIGNALS = [
  ['suspend (ctx.wait / triggerAndWait)', new SuspendSignal(3)],
  ['end-of-execution (this attempt already failed)', executionEnded()],
] as const;

describe('isControlFlowSignal', () => {
  it.each(SIGNALS)('recognizes the %s signal', (_what, signal) => {
    expect(isControlFlowSignal(signal)).toBe(true);
  });

  it('covers the control-flow signal union exactly', () => {
    // The list above restates what the runtime can throw at user code. Pin it
    // to the predicate's own narrowing at the type level, so a third signal
    // added to core fails typecheck here instead of quietly making every
    // `if (isControlFlowSignal(err)) throw err` in the wild incomplete.
    type Listed = (typeof SIGNALS)[number][1];
    type Narrowed = typeof isControlFlowSignal extends (e: unknown) => e is infer T
      ? T
      : never;
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
    const exhaustive: Exact<Listed, Narrowed> = true;
    expect(exhaustive).toBe(true);
  });

  it('leaves real errors alone — a catch that rethrows signals still handles them', () => {
    for (const err of [
      new Error('boom'),
      new AbortError('non-retryable'),
      new TypeError('x is not a function'),
      'a thrown string',
      null,
      undefined,
      { isBetterTriggerExecutionDone: false },
    ]) {
      expect(isControlFlowSignal(err)).toBe(false);
    }
  });

  it('cross-realm signals count too (brand, not instanceof)', () => {
    // A duplicated core (two copies in node_modules, or a bundled worker) still
    // has to be recognized: rethrow advice that depends on instanceof would
    // silently stop working there.
    const foreignSuspend = { isBetterTriggerSuspend: true, seq: 1 };
    expect(isControlFlowSignal(foreignSuspend)).toBe(true);
    expect(isSuspendSignal(foreignSuspend)).toBe(true);
  });
});
