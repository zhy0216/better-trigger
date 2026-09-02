/* =============================================================================
   @better-trigger/worker — p2-18 C3: the executor's log flush has a ceiling.

   Pre-fix, every LOG_FLUSH_THRESHOLD crossing (and the 1s timer) started its
   OWN appendLogs with no in-flight bound: against a slow database a chatty
   run held log-rate × query-duration lines in memory, growing without
   ceiling until the process did. The flushes now serialise through one
   appendLogs at a time (opportunistic ones queue up to LOG_FLUSH_QUEUE_MAX
   deep; the awaited flushes of execution transitions still queue past that,
   preserving logs-before-terminal ordering), and the buffer is capped at
   LOG_BUFFER_MAX with a drop-oldest overflow reported through the existing
   logFlushErrors bucket.

   Driven through the real runtime against a fake kernel whose appendLogs is
   deliberately slow.
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface SlowKernelOpts {
  /** How long each appendLogs takes. */
  delayMs: number;
}

function slowKernel(opts: SlowKernelOpts) {
  let inFlight = 0;
  let maxInFlight = 0;
  const batches: number[] = [];
  let handedOut = false;
  const calls = { completeRun: 0, appends: 0 };
  const kernel = {
    registerWorker: async () => ({ workerId: 'w1' }),
    startOrchestrator: () => ({ stop: () => {} }),
    claimRuns: async () => {
      if (handedOut) return [];
      handedOut = true;
      return [RUN];
    },
    heartbeat: async () => ({ cancelRunIds: [], lostRunIds: [] }),
    reportStep: async () => {},
    completeRun: async () => {
      calls.completeRun += 1;
    },
    failRun: async () => ({ willRetry: false }),
    appendLogs: async (_runId: string, _ns: unknown, logs: unknown[]) => {
      calls.appends += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      batches.push(logs.length);
      await sleep(opts.delayMs);
      inFlight -= 1;
    },
    releaseClaims: async () => ({ releasedRunIds: [] }),
    deregisterWorker: async () => {},
  } as unknown as Kernel;
  return {
    kernel,
    calls,
    maxInFlight: () => maxInFlight,
    delivered: () => batches.reduce((n, b) => n + b, 0),
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

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

/** A task that logs `n` lines, yielding to the event loop every `every` lines
 *  so queued flush steps actually get their turn between bursts. */
function chattyTask(n: number, every: number) {
  return task(
    'demo',
    async (_payload: unknown, ctx) => {
      for (let i = 0; i < n; i++) {
        ctx.logger.info(`line ${i}`);
        if (i % every === 0) await sleep(0);
      }
      return 'done';
    },
  );
}

describe('bounded log flushing (p2-18 C3)', () => {
  it('serialises flushes against a slow database and delivers every line', async () => {
    const f = slowKernel({ delayMs: 15 });
    const { logger } = recordingLogger();

    const handle = await startWorkerRuntime(
      { kernel: f.kernel, logger },
      { tasks: [chattyTask(800, 20)], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => f.calls.completeRun > 0);
    await handle.stop();

    // One appendLogs at a time — the threshold crossings no longer fan out.
    expect(f.maxInFlight()).toBe(1);
    // Nothing was dropped under the cap: 800 lines in, 800 lines out.
    expect(f.delivered()).toBe(800);
    expect(handle.counters.logFlushErrors).toBe(0);
  }, 20_000);

  it('caps the buffered backlog with counted drop-oldest instead of growing forever', async () => {
    const f = slowKernel({ delayMs: 60 });
    const { logger, lines } = recordingLogger();

    // 3000 lines produced without yielding: the queue cap is reached, the
    // buffer hits its cap, and the overflow drops (oldest-first) under the
    // existing error bucket.
    const handle = await startWorkerRuntime(
      { kernel: f.kernel, logger },
      { tasks: [chattyTask(3000, 3000)], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await waitFor(() => f.calls.completeRun > 0);
    await handle.stop();

    expect(f.maxInFlight()).toBe(1); // still one appendLogs at a time
    // The drops were said out loud, and counted through logFlushErrors.
    expect(handle.counters.logFlushErrors).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('oldest buffered log line(s)'))).toBe(true);
    expect(lines.some((l) => l.includes('not draining'))).toBe(true);
    // What did get shipped is bounded well under the burst, non-zero, and the
    // loss is exactly what the cap accounts for: delivered + dropped == 3000.
    expect(f.delivered()).toBeGreaterThan(0);
    expect(f.delivered()).toBeLessThanOrEqual(1_050);
    expect(handle.counters.logFlushErrors).toBeLessThanOrEqual(3_000 - f.delivered());
    // The run itself is untouched by all this: still completed.
    expect(handle.counters.runOutcomes.completed).toBe(1);
  }, 20_000);
});
