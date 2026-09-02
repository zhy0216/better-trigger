/* =============================================================================
   @better-trigger/worker — namespace scan rotation, from the runtime's side
   (P0-14).

   The kernel rotates when it is TOLD to (claim-rotation.test.ts pins the
   mechanism); the fairness guarantee only holds because the runtime owns the
   rotation state and advances it once per claim call. That wiring is the
   whole fix at this layer, and it fails silently if it breaks — a constant
   rotateFrom is exactly the old starvation behaviour.

   Also pinned: the onScanSkipped the runtime passes is a live warning path —
   the kernel hands it the namespaces the budget never reached, and it must
   surface through the throttled logger (bounded per window, not per poll).

   Driven against a fake kernel (no Postgres).
   ============================================================================= */
import type { Namespace } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import { task } from 'better-trigger';
import { describe, expect, it } from 'vitest';
import { startWorkerRuntime } from '../src/runtime';

const NS_A: Namespace = { projectId: 'acme', env: 'staging' };
const NS_B: Namespace = { projectId: 'acme', env: 'prod' };

interface ClaimArgs {
  rotateFrom?: number;
  namespaces: readonly Namespace[];
  onScanSkipped?: (skipped: readonly Namespace[]) => void;
}

function fakeKernel() {
  const claims: ClaimArgs[] = [];
  const kernel = {
    registerWorker: async () => ({ workerId: 'w1' }),
    startOrchestrator: () => ({ stop: () => {} }),
    claimRuns: async (args: ClaimArgs) => {
      claims.push(args);
      return [];
    },
    heartbeat: async () => ({ cancelRunIds: [], lostRunIds: [] }),
    releaseClaims: async () => ({ releasedRunIds: [] }),
    deregisterWorker: async () => {},
  } as unknown as Kernel;
  return { kernel, claims };
}

function fakeLogger() {
  const warnings: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => warnings.push(args),
    error: () => {},
  };
  return { logger, warnings };
}

/** Poll until `fn` holds — the claim loops are timers, not promises. */
async function waitFor(fn: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const alpha = task('alpha', async () => 'a');

describe('claim loop namespace rotation (P0-14)', () => {
  it('advances rotateFrom by one per claim call, cycling over the namespaces', async () => {
    const { kernel, claims } = fakeKernel();

    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [alpha], concurrency: 1, namespaces: [NS_A, NS_B] },
    );
    await waitFor(() => claims.length >= 4);
    await handle.stop();

    // 0, 1, 0, 1, … — every namespace leads the scan order within
    // namespaces.length calls, so a busy ns[0] cannot monopolize the budget.
    expect(claims.slice(0, 4).map((c) => c.rotateFrom)).toEqual([0, 1, 0, 1]);
    expect(claims[0]!.namespaces).toEqual([NS_A, NS_B]);
  }, 10_000);

  it('pins rotateFrom to 0 with a single namespace (rotation is a no-op)', async () => {
    const { kernel, claims } = fakeKernel();

    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [alpha], concurrency: 1, namespaces: [NS_A] },
    );
    await waitFor(() => claims.length >= 2);
    await handle.stop();

    expect(new Set(claims.map((c) => c.rotateFrom))).toEqual(new Set([0]));
  }, 10_000);

  it('warns (throttled) when the budget skips a namespace scan', async () => {
    const { kernel, claims } = fakeKernel();
    const { logger, warnings } = fakeLogger();

    const handle = await startWorkerRuntime(
      { kernel, logger },
      { tasks: [alpha], concurrency: 1, namespaces: [NS_A, NS_B] },
    );
    await waitFor(() => claims.length >= 1);
    await handle.stop();

    const cb = claims[0]!.onScanSkipped;
    expect(typeof cb).toBe('function');
    // The kernel reports the unscanned tail; it must reach the logger with
    // the skipped namespace named.
    cb!([NS_B]);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain('acme/prod');
    expect(String(warnings[0]![0])).toContain('claim budget was met before scanning');

    // Repeats inside the throttle window cost no further lines — a busy
    // ns[0] must not turn the warning into one line per poll.
    cb!([NS_B]);
    cb!([NS_B]);
    expect(warnings).toHaveLength(1);
  }, 10_000);
});
