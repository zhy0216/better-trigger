/* =============================================================================
   @better-trigger/worker — version pinning, from the runtime's side.

   resolveTaskVersion is unit-tested on its own (runtime.test.ts) and the SQL
   filter is pinned in the kernel (claim-pinning.test.ts). What is left is the
   wiring between them, and it is exactly the part that fails silently if it
   breaks: a version that never reaches registration means runs are stamped with
   the wrong one, and versions that never reach claimRuns mean --pin-code-version
   is a flag that does nothing.

   Driven against a fake kernel (no Postgres).
   ============================================================================= */
import type { TaskManifest } from '@better-trigger/core';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import { task } from 'better-trigger';
import { describe, expect, it } from 'vitest';
import { resolveTaskVersion, startWorkerRuntime } from '../src/runtime';

function fakeKernel() {
  const calls = {
    register: [] as Array<{ codeVersion: string; tasks: TaskManifest[] }>,
    claims: [] as Array<{ taskIds: string[]; codeVersions?: string[] }>,
    orchestrator: [] as Array<Record<string, unknown> | undefined>,
  };
  const kernel = {
    registerWorker: async (args: any) => {
      calls.register.push(args);
      return { workerId: 'w1' };
    },
    startOrchestrator: (opts?: Record<string, unknown>) => {
      calls.orchestrator.push(opts);
      return { stop: () => {} };
    },
    claimRuns: async (args: any) => {
      calls.claims.push(args);
      return [];
    },
    heartbeat: async () => ({ cancelRunIds: [], lostRunIds: [] }),
    releaseClaims: async () => ({ releasedRunIds: [] }),
    deregisterWorker: async () => {},
  } as unknown as Kernel;
  return { kernel, calls };
}

const alpha = task('alpha', async () => 'a');
const beta = task('beta', async () => 'b');

/** Poll until `fn` holds — the claim loops are timers, not promises. */
async function waitFor(fn: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('registration', () => {
  it('reports a per-task version on every manifest, plus the deploy version', async () => {
    const { kernel, calls } = fakeKernel();

    const handle = await startWorkerRuntime({ kernel }, { tasks: [alpha, beta], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] });
    await handle.stop();

    const [reg] = calls.register;
    expect(reg!.tasks.map((t) => t.id)).toEqual(['alpha', 'beta']);
    expect(reg!.tasks.map((t) => t.codeVersion)).toEqual([
      resolveTaskVersion(alpha.__definition),
      resolveTaskVersion(beta.__definition),
    ]);
    // Two tasks, two different versions — this is the property that keeps an
    // edit to one from freezing the in-flight runs of the other.
    expect(reg!.tasks[0]!.codeVersion).not.toBe(reg!.tasks[1]!.codeVersion);
    // And the worker-level version is still its own thing: which build is this.
    expect(reg!.codeVersion).toMatch(/^v_[0-9a-f]{12}$/);
    expect(reg!.codeVersion).not.toBe(reg!.tasks[0]!.codeVersion);
  }, 10_000);
});

describe('claim loops', () => {
  it('send no versions by default, so any worker claims any run', async () => {
    const { kernel, calls } = fakeKernel();

    const handle = await startWorkerRuntime({ kernel }, { tasks: [alpha], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] });
    await waitFor(() => calls.claims.length > 0);
    await handle.stop();

    expect(calls.claims[0]!.taskIds).toEqual(['alpha']);
    // Undefined, not an empty array: the kernel keys "filter or not" off the
    // field's presence, and `[]` would pin every task to nothing.
    expect(calls.claims[0]!.codeVersions).toBeUndefined();
  }, 10_000);

  it('send the versions they serve, positionally, when pinning is on', async () => {
    const { kernel, calls } = fakeKernel();

    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [alpha, beta], concurrency: 1, pinCodeVersion: true, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => calls.claims.length > 0);
    await handle.stop();

    const claim = calls.claims[0]!;
    expect(claim.taskIds).toEqual(['alpha', 'beta']);
    expect(claim.codeVersions).toEqual([
      resolveTaskVersion(alpha.__definition),
      resolveTaskVersion(beta.__definition),
    ]);
    // The kernel reads them as pairs by position; a reordering here would pin
    // alpha's runs to beta's version.
    expect(claim.codeVersions).toHaveLength(claim.taskIds.length);
  }, 10_000);

  it('register the version they claim with, so a fresh deploy is self-consistent', async () => {
    const { kernel, calls } = fakeKernel();

    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [alpha], concurrency: 1, pinCodeVersion: true, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => calls.claims.length > 0);
    await handle.stop();

    // The version this worker stamps new runs with (registration) and the one
    // it will accept (claim) must be the same string, or a pinned worker could
    // not claim the runs it had just created.
    expect(calls.claims[0]!.codeVersions).toEqual([calls.register[0]!.tasks[0]!.codeVersion]);
  }, 10_000);
});
