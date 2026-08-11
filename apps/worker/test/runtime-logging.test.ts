/* =============================================================================
   @better-trigger/worker — the swallowed errors reach a log (todos/03 O3).

   Every catch exercised here still swallows: the assertion in each case is
   "warned, counted, and the loop is still running afterwards". Driven against a
   fake kernel (no Postgres) whose calls fail on demand.
   ============================================================================= */
import type { ClaimedRun } from '@better-trigger/core';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import { task } from 'better-trigger';
import { describe, expect, it } from 'vitest';
import { startWorkerRuntime } from '../src/runtime';

const RUN: ClaimedRun = {
  id: 'run_1',
  taskId: 'demo',
  payload: {},
  attempt: 1,
  maxAttempts: 3,
  codeVersion: null,
  projectId: 'default',
  env: 'dev',
  steps: [],
  fencingToken: 1,
};

function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      warn: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
    },
  };
}

interface Behavior {
  /** Reject this many claims before handing out RUN. */
  claimFailures?: number;
  heartbeatFails?: boolean;
  /** Reject the failed-step row only; the run itself still fails cleanly. */
  reportStepFails?: boolean;
  completeRunFails?: boolean;
  failRunFails?: boolean;
  appendLogsFails?: boolean;
}

function fakeKernel(b: Behavior = {}) {
  const calls = {
    claims: 0,
    heartbeats: 0,
    reportStep: 0,
    completeRun: 0,
    failRun: 0,
    appendLogs: 0,
  };
  let handedOut = false;
  const kernel = {
    registerWorker: async () => ({ workerId: 'w1' }),
    startOrchestrator: () => ({ stop: () => {} }),
    claimRuns: async () => {
      calls.claims += 1;
      if (calls.claims <= (b.claimFailures ?? 0)) throw new Error('connection refused');
      if (handedOut) return [];
      handedOut = true;
      return [RUN];
    },
    heartbeat: async () => {
      calls.heartbeats += 1;
      if (b.heartbeatFails) throw new Error('connection refused');
      return { cancelRunIds: [], lostRunIds: [] };
    },
    reportStep: async () => {
      calls.reportStep += 1;
      if (b.reportStepFails) throw new Error('write failed');
    },
    completeRun: async () => {
      calls.completeRun += 1;
      if (b.completeRunFails) throw new Error('write failed');
    },
    failRun: async () => {
      calls.failRun += 1;
      if (b.failRunFails) throw new Error('write failed');
      return { willRetry: false };
    },
    appendLogs: async () => {
      calls.appendLogs += 1;
      if (b.appendLogsFails) throw new Error('write failed');
    },
  } as unknown as Kernel;
  return { kernel, calls };
}

async function waitFor(pred: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ok = task('demo', async () => 'done');

describe('claim failures', () => {
  it('warns with the loop and worker, counts them, and keeps claiming', async () => {
    const { kernel, calls } = fakeKernel({ claimFailures: 3 });
    const { lines, logger } = recordingLogger();

    const handle = await startWorkerRuntime(
      { kernel, logger },
      { tasks: [ok], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    // The loop survived the outage: a claim after it came back was executed.
    await waitFor(() => calls.completeRun > 0);
    await handle.stop();

    const warned = lines.filter((l) => l.includes('claim failed'));
    expect(warned.length).toBeGreaterThan(0);
    expect(warned[0]).toContain('worker=w1');
    expect(warned[0]).toContain('slot=0');
    expect(warned[0]).toContain('no runs are being picked up');
    expect(warned[0]).toContain('connection refused');
    // Three failures, one line: the throttle folds a repeating outage.
    expect(warned).toHaveLength(1);

    expect(handle.counters.claimErrors).toBe(3);
    // ...and the "in a row" gauge is back to zero once a claim lands.
    expect(handle.counters.consecutiveClaimErrors).toBe(0);
  }, 15_000);
});

describe('heartbeat failures', () => {
  it('warns that leases are not being renewed, and the loops carry on', async () => {
    const { kernel, calls } = fakeKernel({ heartbeatFails: true });
    const { lines, logger } = recordingLogger();

    // leaseMs/3 < the 500ms floor, so the first tick lands at 500ms.
    const handle = await startWorkerRuntime(
      { kernel, logger },
      { tasks: [ok], concurrency: 1, leaseMs: 1_200, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => lines.some((l) => l.includes('heartbeat failed')));
    // Claiming is unaffected — the heartbeat is its own loop.
    await waitFor(() => calls.completeRun > 0);
    const beats = calls.heartbeats;
    await waitFor(() => calls.heartbeats > beats); // still ticking after the throw
    await handle.stop();

    const warned = lines.filter((l) => l.includes('heartbeat failed'));
    expect(warned[0]).toContain('worker=w1');
    expect(warned[0]).toContain('leases are not being renewed');
    expect(handle.counters.heartbeatErrors).toBeGreaterThan(0);
    expect(handle.counters.consecutiveHeartbeatErrors).toBeGreaterThan(0);
  }, 15_000);
});

describe('an executor that throws out of execute()', () => {
  it('names the run it lost and leaves the loop claiming', async () => {
    const { kernel, calls } = fakeKernel({ completeRunFails: true });
    const { lines, logger } = recordingLogger();

    const handle = await startWorkerRuntime(
      { kernel, logger },
      { tasks: [ok], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => lines.some((l) => l.includes('executor threw')));
    const claims = calls.claims;
    await waitFor(() => calls.claims > claims); // loop did not die with the run
    await handle.stop();

    const warned = lines.find((l) => l.includes('executor threw'))!;
    expect(warned).toContain('run run_1');
    expect(warned).toContain('task=demo');
    expect(warned).toContain('slot=0');
    expect(warned).toContain('lease reaper');
    expect(handle.counters.executorErrors).toBe(1);
    // Swallowed, not rethrown: no in-flight run is left behind either.
    expect(handle.inFlightRunIds()).toEqual([]);
  }, 15_000);
});

describe('a failed-step row that cannot be written', () => {
  it('names the step missing from the timeline, and the run still fails', async () => {
    const { kernel, calls } = fakeKernel({ reportStepFails: true });
    const { lines, logger } = recordingLogger();
    const boom = task('demo', async (_payload: unknown, ctx) => {
      await ctx.step('charge-card', async () => {
        throw new Error('step blew up');
      });
    });

    const handle = await startWorkerRuntime(
      { kernel, logger },
      { tasks: [boom], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => lines.some((l) => l.includes('failed-step report failed')));
    // The run itself was still failed — only the step row went missing.
    await waitFor(() => calls.failRun > 0);
    await handle.stop();

    const warned = lines.find((l) => l.includes('failed-step report failed'))!;
    expect(warned).toContain('run run_1');
    expect(warned).toContain('task=demo');
    expect(warned).toContain('label=charge-card');
    expect(warned).toContain('missing from its timeline');
    expect(handle.counters.stepReportErrors).toBe(1);
    // Reported through the normal path, not absorbed by the loop-level guard.
    expect(handle.counters.failReportErrors).toBe(0);
    expect(handle.counters.executorErrors).toBe(0);
  }, 15_000);
});

describe('a failure the executor cannot report', () => {
  it('warns that the run stays running, and the run does not crash the loop', async () => {
    const { kernel, calls } = fakeKernel({ failRunFails: true });
    const { lines, logger } = recordingLogger();
    const boom = task('demo', async () => {
      throw new Error('task blew up');
    });

    const handle = await startWorkerRuntime(
      { kernel, logger },
      { tasks: [boom], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => lines.some((l) => l.includes('failRun report failed')));
    const claims = calls.claims;
    await waitFor(() => calls.claims > claims);
    await handle.stop();

    const warned = lines.find((l) => l.includes('failRun report failed'))!;
    expect(warned).toContain('run run_1');
    expect(warned).toContain('attempt=1');
    expect(handle.counters.failReportErrors).toBe(1);
    // The executor absorbed it: the loop-level guard never saw a throw.
    expect(handle.counters.executorErrors).toBe(0);
  }, 15_000);
});

describe('a log flush that fails', () => {
  it('reports how many lines were dropped and still completes the run', async () => {
    const { kernel, calls } = fakeKernel({ appendLogsFails: true });
    const { lines, logger } = recordingLogger();
    const chatty = task('demo', async (_payload: unknown, ctx) => {
      ctx.logger.info('hello');
      return 'done';
    });

    const handle = await startWorkerRuntime(
      { kernel, logger },
      { tasks: [chatty], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => lines.some((l) => l.includes('dropped 1 log line(s)')));
    await waitFor(() => calls.completeRun > 0);
    await handle.stop();

    const warned = lines.find((l) => l.includes('dropped 1 log line(s)'))!;
    expect(warned).toContain('run run_1');
    expect(handle.counters.logFlushErrors).toBe(1);
  }, 15_000);
});
