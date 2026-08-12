/* =============================================================================
   @better-trigger/worker — shutdown aborts in-flight runs and hands them back.

   stop() used to sit out SHUTDOWN_DRAIN_MS (30s) waiting for a step whose result
   this process will never report. It now aborts ctx.signal first, so a step that
   honors the signal unwinds immediately. Driven against a fake kernel (no
   Postgres): the run is claimed once, blocks on ctx.signal, and stop() must
   return in well under the drain window without reporting a failure.

   The second half covers C3 (todos/01-correctness.md): what did not drain must
   not be left holding a claim and a live lease. stop() releases this worker's
   claims and marks its row offline — after the heartbeat is stopped (which
   would otherwise renew the leases and flip the row back to 'online'), and
   without ever reporting a failure for the run, since attempt is the kernel's
   business and a handover spends none of it.
   ============================================================================= */
import type { ClaimedRun } from '@better-trigger/core';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import type { Kernel } from '@better-trigger/kernel';
import { isRunAborted, task, type RunAbortedError } from 'better-trigger';
import { describe, expect, it } from 'vitest';
import { startWorkerRuntime } from '../src/runtime';

const RUN: ClaimedRun = {
  id: 'run_1',
  taskId: 'slow',
  payload: {},
  attempt: 1,
  maxAttempts: 3,
  codeVersion: null,
  projectId: 'default',
  env: 'dev',
  steps: [],
  fencingToken: 1,
};

interface FakeOptions {
  /** Make the shutdown hand-back fail, to prove stop() survives it. */
  handBackThrows?: boolean;
  /**
   * Hold every heartbeat until the returned `releaseHeartbeat()` is called, so a
   * tick is provably in flight at stop() without timing the sleep against it.
   */
  gateHeartbeat?: boolean;
  /**
   * p1-12: the first claim poll comes back empty (the slot goes idle), then the
   * next one parks on the returned `pendingClaim` until `releaseClaim()` is
   * called — so a claim can be made to resolve only once stop() has begun.
   */
  deferClaim?: boolean;
}

function fakeKernel(opts: FakeOptions = {}) {
  const calls = {
    reportStep: [] as any[],
    failRun: [] as any[],
    completeRun: [] as any[],
    releaseClaims: [] as any[],
    deregisterWorker: [] as any[],
  };
  /** Chronological trace, so "the heartbeat stopped first" is checkable. */
  const order: string[] = [];
  let openTheGate!: () => void;
  const gate = new Promise<void>((r) => {
    openTheGate = r;
  });
  let announceStart!: () => void;
  const firstHeartbeatStarted = new Promise<void>((r) => {
    announceStart = r;
  });
  let handedOut = false;
  // p1-12: the deferred a late claim parks on until the test releases it, plus
  // the signal that the slot is actually parked — so "the claim resolves after
  // stop()" is a fact here, not a race won against the idle backoff.
  let releaseClaim!: () => void;
  const pendingClaim = new Promise<void>((r) => {
    releaseClaim = r;
  });
  let announceClaimPending!: () => void;
  const claimPending = new Promise<void>((r) => {
    announceClaimPending = r;
  });
  let firstClaim = true;
  const kernel = {
    registerWorker: async () => ({ workerId: 'w1' }),
    startOrchestrator: () => ({ stop: () => {} }),
    claimRuns: async () => {
      if (opts.deferClaim) {
        // First poll: nothing due, the slot backs off. Second poll: parked on
        // the deferred, so the claim can only resolve once the test lets go.
        if (firstClaim) {
          firstClaim = false;
          return [];
        }
        announceClaimPending();
        await pendingClaim;
        return [RUN];
      }
      if (handedOut) return [];
      handedOut = true;
      return [RUN];
    },
    heartbeat: async () => {
      order.push('heartbeat:start');
      announceStart();
      // The workers row is written when this resolves, not when it is called —
      // which is why a tick still in flight at stop() matters.
      if (opts.gateHeartbeat) await gate;
      order.push('heartbeat:end');
      return { cancelRunIds: [], lostRunIds: [] };
    },
    releaseClaims: async (input: any) => {
      order.push('releaseClaims');
      calls.releaseClaims.push(input);
      if (opts.handBackThrows) throw new Error('pg is gone');
      return { releasedRunIds: [RUN.id] };
    },
    deregisterWorker: async (input: any) => {
      order.push('deregisterWorker');
      calls.deregisterWorker.push(input);
      if (opts.handBackThrows) throw new Error('pg is gone');
    },
    reportStep: async (input: any) => {
      calls.reportStep.push(input);
    },
    failRun: async (input: any) => {
      calls.failRun.push(input);
    },
    completeRun: async (input: any) => {
      calls.completeRun.push(input);
    },
    appendLogs: async () => {},
  } as unknown as Kernel;
  return { kernel, calls, order, firstHeartbeatStarted, releaseHeartbeat: openTheGate, claimPending, releaseClaim };
}

/** A task that starts a step and then blocks until ctx.signal aborts. */
function blockingTask(onStart: () => void) {
  return task('slow', (_payload: unknown, ctx) =>
    ctx.step('llm-call', () => {
      onStart();
      // The agent-shaped step: minutes long, cut short only by ctx.signal.
      return new Promise<never>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
      });
    }),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('startWorkerRuntime().stop()', () => {
  it('aborts in-flight steps instead of waiting out the drain window', async () => {
    const { kernel, calls } = fakeKernel();
    let started!: () => void;
    const stepStarted = new Promise<void>((r) => {
      started = r;
    });
    let reason: RunAbortedError | undefined;

    const slow = task('slow', (_payload: unknown, ctx) =>
      ctx.step('llm-call', () => {
        started();
        // The agent-shaped step: minutes long, cut short only by ctx.signal.
        return new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              reason = ctx.signal.reason;
              reject(ctx.signal.reason);
            },
            { once: true },
          );
        });
      }),
    );

    const handle = await startWorkerRuntime({ kernel }, { tasks: [slow], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] });
    await stepStarted;

    const t0 = Date.now();
    await handle.stop();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2_000); // SHUTDOWN_DRAIN_MS is 30s
    expect(isRunAborted(reason)).toBe(true);
    expect(reason?.reason).toBe('shutting_down');
    // The lease reaper requeues the run; nothing is written for this attempt.
    expect(calls.reportStep).toEqual([]);
    expect(calls.failRun).toEqual([]);
    expect(calls.completeRun).toEqual([]);
  });
});

describe('startWorkerRuntime().stop() hand-back (C3)', () => {
  it('releases this worker\'s claims and marks it offline', async () => {
    const { kernel, calls } = fakeKernel();
    let started!: () => void;
    const stepStarted = new Promise<void>((r) => {
      started = r;
    });

    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [blockingTask(() => started())], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await stepStarted;
    await handle.stop();

    // Both scoped to this worker + its namespaces: releasing by worker id is
    // what keeps a shutting-down daemon from touching another daemon's claims.
    expect(calls.releaseClaims).toEqual([
      { workerId: handle.workerId, namespaces: [DEFAULT_NAMESPACE] },
    ]);
    expect(calls.deregisterWorker).toEqual([{ workerId: handle.workerId }]);
    // Still a handover, not a failure — nothing is reported for the attempt,
    // so nothing can charge one.
    expect(calls.failRun).toEqual([]);
    expect(calls.completeRun).toEqual([]);
  });

  it('stops the heartbeat before handing anything back', async () => {
    // A heartbeat landing after the release would renew the very leases just
    // dropped AND set the workers row back to 'online' (it writes status =
    // 'online' on every tick) — the hand-back would undo itself.
    const { kernel, order } = fakeKernel();
    let started!: () => void;
    const stepStarted = new Promise<void>((r) => {
      started = r;
    });

    const handle = await startWorkerRuntime(
      { kernel },
      // leaseMs/3 floors at MIN_HEARTBEAT_MS, so this beats every 500ms.
      { tasks: [blockingTask(() => started())], concurrency: 1, leaseMs: 1_500, namespaces: [DEFAULT_NAMESPACE] },
    );
    await stepStarted;
    await sleep(700); // at least one heartbeat while the run is in flight
    await handle.stop();
    await sleep(800); // any surviving timer would fire twice over in this window

    expect(order).toContain('heartbeat:end');
    expect(order.lastIndexOf('heartbeat:end')).toBeLessThan(order.indexOf('releaseClaims'));
    expect(order.indexOf('releaseClaims')).toBeLessThan(order.indexOf('deregisterWorker'));
  });

  it('waits out a heartbeat already in flight before handing back', async () => {
    // clearInterval stops the next tick, not the one currently awaiting
    // Postgres. That tick's second statement is
    // `UPDATE workers SET last_heartbeat_at = now(), status = 'online'`, so if
    // it commits after deregisterWorker the row is online again until the
    // offline marker corrects it minutes later — C3's third symptom, reappearing
    // through the fix for it. The trace must show the tick finishing first.
    const { kernel, order, firstHeartbeatStarted, releaseHeartbeat } = fakeKernel({
      gateHeartbeat: true,
    });
    let started!: () => void;
    const stepStarted = new Promise<void>((r) => {
      started = r;
    });

    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [blockingTask(() => started())], concurrency: 1, leaseMs: 1_500, namespaces: [DEFAULT_NAMESPACE] },
    );
    await stepStarted;
    // Gated rather than timed: the tick is held open until this test lets go, so
    // "a heartbeat is in flight at stop()" is a fact here, not a race won.
    await firstHeartbeatStarted;
    expect(order.at(-1)).toBe('heartbeat:start');

    // Hold the tick open well past the point an unguarded stop() would reach
    // releaseClaims (the drain resolves in milliseconds once ctx.signal fires).
    // With the fix, stop() parks on this tick and the delay is irrelevant;
    // without it, releaseClaims lands first and the ordering assertion below
    // fails — which is exactly the regression this test exists to catch.
    const stopped = handle.stop();
    const releasedAt = sleep(300).then(releaseHeartbeat);
    await Promise.all([stopped, releasedAt]);

    const lastEnd = order.lastIndexOf('heartbeat:end');
    expect(lastEnd).toBeGreaterThan(-1);
    expect(lastEnd).toBeLessThan(order.indexOf('releaseClaims'));
    // No tick may be left dangling past the hand-back.
    expect(order.filter((o) => o === 'heartbeat:start')).toHaveLength(
      order.filter((o) => o === 'heartbeat:end').length,
    );
  });

  it('still exits when the hand-back fails, and hands back once per stop', async () => {
    // stop() runs on the crash path too: a dead pool must cost the process its
    // claims (the reaper picks them up, as before C3), never its exit.
    const { kernel, calls } = fakeKernel({ handBackThrows: true });
    const warnings: unknown[] = [];
    let started!: () => void;
    const stepStarted = new Promise<void>((r) => {
      started = r;
    });

    const handle = await startWorkerRuntime(
      {
        kernel,
        logger: { warn: (...a: unknown[]) => warnings.push(a), error: () => {} },
      },
      { tasks: [blockingTask(() => started())], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    await stepStarted;

    await expect(handle.stop()).resolves.toBeUndefined();
    // Concurrent shutdown paths (a signal during a crash drain) share the one
    // attempt rather than releasing twice.
    await handle.stop();
    await handle.stop();

    expect(calls.releaseClaims).toHaveLength(1);
    expect(calls.deregisterWorker).toHaveLength(1);
    // Both failures are reported rather than swallowed into silence.
    expect(warnings).toHaveLength(2);
  });
});

describe('a claim that resolves after stop() began (p1-12)', () => {
  it('hands the run back instead of executing it, and does not hold the drain open', async () => {
    // p1-12: the run's claim was already bumped (fencing token++) by the claim
    // itself, but the slot had not started executing when stop() flipped
    // `stopping`. The slot must hand the run back by id — claimable at once,
    // no executor, no attempt spent — and break out so the drain is not parked
    // behind a run this process will never touch.
    const { kernel, calls, claimPending, releaseClaim } = fakeKernel({ deferClaim: true });
    const executed: string[] = [];
    const neverExecuted = task('slow', async () => {
      executed.push('executed');
      return 'done';
    });

    const handle = await startWorkerRuntime(
      { kernel },
      { tasks: [neverExecuted], concurrency: 1, namespaces: [DEFAULT_NAMESPACE] },
    );
    // The slot's first poll came back empty (it is mid-backoff); the second
    // poll is now parked on the deferred — the claim that must resolve only
    // after stop() has begun.
    await claimPending;

    const t0 = Date.now();
    const stopped = handle.stop();
    releaseClaim();
    await stopped;
    const elapsed = Date.now() - t0;

    // The late claim is released by run id, alongside the hand-back's
    // worker-wide release that runs after the drain.
    expect(calls.releaseClaims[0]).toEqual({
      workerId: handle.workerId,
      namespaces: [DEFAULT_NAMESPACE],
      runIds: [RUN.id],
    });
    // Never executed: not a byte of the run's body ran, and no executor existed
    // to report anything — there is no trace of output of any kind.
    expect(executed).toEqual([]);
    expect(calls.reportStep).toEqual([]);
    expect(calls.failRun).toEqual([]);
    expect(calls.completeRun).toEqual([]);
    // stop() resolves immediately: the never-executed run cannot hold the drain
    // open (SHUTDOWN_DRAIN_MS is 30s).
    expect(elapsed).toBeLessThan(2_000);
  });
});
