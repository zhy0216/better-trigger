/* =============================================================================
   @better-trigger/testing — assertion primitives.

   Deliberately tiny and framework-free: the acceptance scenarios are bun
   scripts, not vitest files, and an assertion here must be usable from both.
   Everything throws `AssertionFailure`, which runScenario() turns into a
   non-zero exit (see scenario.ts) instead of each script calling
   process.exit(1) from inside its own helper.
   ============================================================================= */

/** Thrown by every assertion in this package. */
export class AssertionFailure extends Error {
  override readonly name = 'AssertionFailure';
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionFailure(msg);
}

/** Structural equality by JSON shape — enough for run outputs / step ledgers. */
export function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionFailure(`${label}: expected ${e}, got ${a}`);
}

/**
 * One line describing a thrown value, for the ✗ output.
 *
 * `err.message` alone is not enough: an unreachable Postgres surfaces as an
 * AggregateError whose own message is empty and whose ECONNREFUSED detail sits
 * in `.errors` — i.e. exactly the failure a CI run most needs spelled out.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const nested =
    err instanceof AggregateError && Array.isArray(err.errors)
      ? err.errors.map(describeError).filter(Boolean).join('; ')
      : '';
  if (err.message && nested) return `${err.message} (${nested})`;
  return err.message || nested || err.name;
}
