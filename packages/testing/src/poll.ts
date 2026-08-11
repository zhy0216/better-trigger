/* =============================================================================
   @better-trigger/testing — polling helpers.

   Every acceptance scenario waits on the database converging to some state
   (a run reaching 'waiting', a task row appearing, a marker line landing).
   These are the two shapes that covers: an arbitrary predicate, and "this run
   reached this status".
   ============================================================================= */
import { AssertionFailure, describeError } from './assert';

/** Structural namespace shape — testing has no dependency on @better-trigger/core. */
interface Namespace {
  projectId: string;
  env: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * What one poll of a `waitFor` predicate concluded: satisfied, not yet, or
 * `{ abort }` — the state being waited for has become unreachable, so waiting
 * out the rest of the timeout can only turn a diagnosable failure into a slow
 * anonymous one. A run that reached a terminal status is the usual case: it
 * will never be 'running' again no matter how long anyone waits.
 */
export type WaitOutcome = boolean | { abort: string };

/**
 * Poll `cond` until it returns true. Throws (→ scenario failure) on timeout,
 * naming what it was waiting for. Exceptions from `cond` are treated as
 * "not yet" — the daemon under test may not have migrated / booted yet — so a
 * predicate that wants to stop early must say so with `{ abort }` rather than
 * by throwing.
 */
export async function waitFor(
  label: string,
  timeoutMs: number,
  cond: () => Promise<WaitOutcome> | WaitOutcome,
  opts: { intervalMs?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let abort: string | null = null;
  while (Date.now() < deadline) {
    try {
      const outcome = await cond();
      if (outcome === true) return;
      if (outcome !== false) abort = outcome.abort;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    // Outside the try: an abort is a verdict, not a transient read failure, so
    // it must not be swallowed as "not yet" the way cond()'s own throws are.
    if (abort !== null) {
      throw new AssertionFailure(`gave up waiting for: ${label} — ${abort}`);
    }
    await sleep(intervalMs);
  }
  const because = lastError ? ` (last error: ${describeError(lastError)})` : '';
  throw new AssertionFailure(`timed out after ${timeoutMs}ms waiting for: ${label}${because}`);
}

/**
 * Anything that can answer "what status is this run in?" — the HTTP client and
 * the kernel both satisfy the object form, so a scenario can poll whichever
 * surface it is testing without an adapter. The optional namespace parameter
 * matches the kernel's namespace-scoped getRun (C2); a single-arg reader (the
 * SDK client) satisfies the same shape.
 */
export type RunStatusReader =
  | ((runId: string) => Promise<string>)
  | { getRun(runId: string, namespace?: Namespace): Promise<{ status: string }> };

function readStatus(reader: RunStatusReader): (runId: string) => Promise<string> {
  if (typeof reader === 'function') return reader;
  return async (runId) => (await reader.getRun(runId)).status;
}

/** Poll a run until it reports `status`; throws on timeout. */
export async function waitForStatus(
  reader: RunStatusReader,
  runId: string,
  status: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const get = readStatus(reader);
  let last = 'unknown';
  await waitFor(
    `run ${runId} to reach '${status}' (last seen '${last}')`,
    timeoutMs,
    async () => {
      last = await get(runId);
      return last === status;
    },
    { intervalMs: opts.intervalMs },
  ).catch(() => {
    throw new AssertionFailure(
      `timed out after ${timeoutMs}ms waiting for run ${runId} to reach '${status}' ` +
        `(last status: '${last}')`,
    );
  });
}
