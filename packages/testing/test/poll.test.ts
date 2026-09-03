/* =============================================================================
   @better-trigger/testing — poll harness unit tests (T1/T4 acceptance).

   Driven by an injected WaitClock where semantics matter (timeout, abort,
   error-swallowing are contracts about the loop, not about wall time), and by
   real time only where the code itself owns the clock.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { AssertionFailure } from '../src/assert';
import { waitFor, waitForStatus, type RunStatusReader, type WaitClock } from '../src/poll';

/** Virtual clock: `sleep` advances the clock instead of waiting on it. */
function fakeClock(): { clock: WaitClock; now(): number } {
  let t = 0;
  return {
    now: () => t,
    clock: {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    },
  };
}

describe('waitFor', () => {
  it('throws the documented timeout error once the deadline passes', async () => {
    const { clock } = fakeClock();
    await expect(waitFor('the thing', 500, () => false, { clock })).rejects.toThrow(
      'timed out after 500ms waiting for: the thing',
    );
  });

  it('preserves the abort verdict verbatim instead of waiting out the timeout', async () => {
    const { clock } = fakeClock();
    let polls = 0;
    await expect(
      waitFor(
        'the thing',
        10_000,
        () => (++polls < 3 ? false : { abort: 'the run already failed' }),
        { intervalMs: 100, clock },
      ),
    ).rejects.toThrow("gave up waiting for: the thing — the run already failed");
    expect(polls).toBe(3);
  });

  it('treats cond() exceptions as "not yet" and resolves once it passes', async () => {
    const { clock } = fakeClock();
    let polls = 0;
    await waitFor(
      'the thing',
      10_000,
      async () => {
        polls += 1;
        if (polls < 3) throw new Error('daemon not migrated yet');
        return true;
      },
      { intervalMs: 100, clock },
    );
    expect(polls).toBe(3);
  });

  it('names the last transient error in the timeout message', async () => {
    const { clock } = fakeClock();
    await expect(
      waitFor('the thing', 300, () => Promise.reject(new Error('ECONNREFUSED')), {
        intervalMs: 100,
        clock,
      }),
    ).rejects.toThrow('timed out after 300ms waiting for: the thing (last error: ECONNREFUSED)');
  });
});

describe('waitForStatus', () => {
  it('aborts fast for a run that reached a terminal status, keeping the message', async () => {
    const { clock } = fakeClock();
    const reader = async (id: string) => (id === 'r1' ? 'failed' : 'queued');
    await expect(
      waitForStatus(reader, 'r1', 'completed', { timeoutMs: 5_000, clock }),
    ).rejects.toThrow(/gave up waiting for: run r1 .* — run reached terminal status 'failed'/);
  });

  it('wraps a pure timeout with the last observed status', async () => {
    const { clock } = fakeClock();
    const reader = async () => 'queued';
    await expect(
      waitForStatus(reader, 'r1', 'completed', { timeoutMs: 500, intervalMs: 100, clock }),
    ).rejects.toThrow(
      new AssertionFailure(
        "timed out after 500ms waiting for run r1 to reach 'completed' (last status: 'queued')",
      ).message,
    );
  });

  it('resolves as soon as the run reports the wanted status', async () => {
    const { clock } = fakeClock();
    await waitForStatus(async () => 'completed', 'r1', 'completed', { clock });
  });

  it('forwards the namespace to an object reader (kernel getRun, C2)', async () => {
    const calls: Array<[string, unknown]> = [];
    const reader = {
      getRun: async (runId: string, namespace?: unknown) => {
        calls.push([runId, namespace]);
        return { status: 'completed' };
      },
    } as unknown as RunStatusReader;
    await waitForStatus(reader, 'r1', 'completed', {
      namespace: { projectId: 'p1', env: 'prod' },
    });
    expect(calls).toEqual([['r1', { projectId: 'p1', env: 'prod' }]]);
  });
});
