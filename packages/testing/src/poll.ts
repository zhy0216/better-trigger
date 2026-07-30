/* =============================================================================
   @better-trigger/testing — polling helpers.

   Every acceptance scenario waits on the database converging to some state
   (a run reaching 'waiting', a task row appearing, a marker line landing).
   These are the two shapes that covers: an arbitrary predicate, and "this run
   reached this status".
   ============================================================================= */
import { AssertionFailure, describeError } from './assert';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `cond` until it returns true. Throws (→ scenario failure) on timeout,
 * naming what it was waiting for. Exceptions from `cond` are treated as
 * "not yet" — the daemon under test may not have migrated / booted yet.
 */
export async function waitFor(
  label: string,
  timeoutMs: number,
  cond: () => Promise<boolean> | boolean,
  opts: { intervalMs?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await cond()) return;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const because = lastError ? ` (last error: ${describeError(lastError)})` : '';
  throw new AssertionFailure(`timed out after ${timeoutMs}ms waiting for: ${label}${because}`);
}

/**
 * Anything that can answer "what status is this run in?" — the HTTP client and
 * the kernel both satisfy the object form, so a scenario can poll whichever
 * surface it is testing without an adapter.
 */
export type RunStatusReader =
  | ((runId: string) => Promise<string>)
  | { getRun(runId: string): Promise<{ status: string }> };

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
