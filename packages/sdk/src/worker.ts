/* =============================================================================
   better-trigger — embedded worker runtime (driven by instance.start()).
   register → orchestrator loops (waits / cron / reaper / offline markers)
            → N concurrent claim-and-execute slots (idle backoff + jitter)
            + a heartbeat loop (max(500, leaseMs/3): lease renewal + cancels).
   Graceful shutdown on SIGINT/SIGTERM: stop claiming, drain in-flight runs,
   stop the loops and (when the instance owns the pool) end it.
   ============================================================================= */
import { createHash } from 'node:crypto';
import type {
  ClaimedRun,
  Kernel,
  OrchestratorOptions,
  RetryPolicy,
} from '@better-trigger/core';
import { Executor } from './executor';
import {
  toExecutorTask,
  toManifest,
  type ResolvedTaskDefinition,
  type TaskHandle,
} from './task';

/** Options accepted by instance.start(). */
export interface StartOptions {
  /** Tasks this worker can execute. */
  tasks: Array<TaskHandle<any, any>>;
  /** Number of concurrent execution slots / claim loops. Default 5. */
  concurrency?: number;
  /** Friendly worker name recorded on registration. */
  name?: string;
  /** Lease duration granted per claim (renewed by heartbeat). Default 60s. */
  leaseMs?: number;
}

/** Handle returned by instance.start(); lets callers stop it programmatically. */
export interface WorkerHandle {
  workerId: string;
  /** Resolves once the worker has fully drained and exited its loops. */
  stop(): Promise<void>;
  /** Promise that resolves when the claim loops exit (e.g. via signal). */
  done: Promise<void>;
}

/** What the owning instance injects into the worker runtime. */
export interface WorkerDeps {
  kernel: Kernel;
  /** Orchestrator loop intervals (instance-level test knobs). */
  orchestrator?: OrchestratorOptions;
  /** Instance default retry, applied to manifests of tasks without their own. */
  defaultRetry?: RetryPolicy;
  /** Invoked after all loops stop; the instance ends its owned pool here. */
  onStopped?: () => Promise<void>;
}

const DEFAULT_LEASE_MS = 60_000;
const MIN_HEARTBEAT_MS = 500;
const IDLE_POLL_BASE_MS = 300;
const IDLE_POLL_MAX_MS = 2_000;
const SHUTDOWN_DRAIN_MS = 30_000;

export async function startWorkerRuntime(
  deps: WorkerDeps,
  options: StartOptions,
): Promise<WorkerHandle> {
  const { kernel } = deps;
  const concurrency = options.concurrency ?? 5;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const definitions = options.tasks.map((t) => t.__definition);
  const taskById = new Map<string, ResolvedTaskDefinition<any, any>>();
  for (const def of definitions) taskById.set(def.id, def);
  const taskIds = definitions.map((d) => d.id);

  const codeVersion = resolveCodeVersion(definitions);
  const manifests = definitions.map(toManifest);
  if (deps.defaultRetry) {
    for (const m of manifests) m.retry ??= deps.defaultRetry;
  }

  const { workerId } = await kernel.registerWorker({
    name: options.name,
    codeVersion,
    runtime: 'self-host',
    concurrency,
    tasks: manifests,
  });

  // Background loops (wait resumption, cron, lease reaper, offline markers)
  // run inside the worker process and stop with it.
  const orchestrator = kernel.startOrchestrator(deps.orchestrator);

  // Runs currently executing, keyed by run id → their Executor (for cancels).
  const inFlight = new Map<string, Executor>();
  let stopping = false;

  /* ---- heartbeat loop --------------------------------------------------- */
  const heartbeatMs = Math.max(MIN_HEARTBEAT_MS, Math.floor(leaseMs / 3));
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const res = await kernel.heartbeat({
          workerId,
          runIds: [...inFlight.keys()],
          leaseMs,
        });
        for (const runId of res.cancelRunIds) {
          inFlight.get(runId)?.markCanceled();
        }
      } catch {
        // best-effort; the lease reaper protects correctness
      }
    })();
  }, heartbeatMs);
  (heartbeatTimer as { unref?: () => void }).unref?.();

  /* ---- one claim-and-execute loop (a single concurrency slot) ----------- */
  async function claimLoop(): Promise<void> {
    let idleBackoff = IDLE_POLL_BASE_MS;
    while (!stopping) {
      let run: ClaimedRun | undefined;
      try {
        const claimed = await kernel.claimRuns({ workerId, taskIds, limit: 1, leaseMs });
        run = claimed[0];
      } catch {
        if (stopping) break;
        // DB hiccup: back off like an idle poll before retrying.
        await sleep(jittered(idleBackoff));
        idleBackoff = Math.min(IDLE_POLL_MAX_MS, idleBackoff * 2);
        continue;
      }

      if (!run) {
        // Nothing due: exponential idle backoff 300ms → 2s, ± jitter.
        await sleep(jittered(idleBackoff));
        idleBackoff = Math.min(IDLE_POLL_MAX_MS, idleBackoff * 2);
        continue;
      }
      idleBackoff = IDLE_POLL_BASE_MS; // got work — claim again immediately after

      const def = taskById.get(run.taskId);
      if (!def) {
        // Should not happen (the claim filters by this worker's task ids);
        // skip safely — the lease reaper recovers the abandoned claim.
        continue;
      }

      const executor = new Executor(kernel, toExecutorTask(def), run, workerId);
      inFlight.set(run.id, executor);
      try {
        await executor.execute();
      } catch {
        // Executor handles its own errors; this guards the loop only.
      } finally {
        inFlight.delete(run.id);
      }
    }
  }

  const loops = Array.from({ length: concurrency }, () => claimLoop());
  const loopsDone = Promise.all(loops).then(() => undefined);

  /* ---- graceful shutdown ------------------------------------------------ */
  let stopPromise: Promise<void> | null = null;
  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      // Claim loops exit at the next check; in-flight runs drain, bounded by
      // SHUTDOWN_DRAIN_MS. The heartbeat stays alive during the drain so
      // leases keep renewing while runs finish.
      await Promise.race([loopsDone, sleep(SHUTDOWN_DRAIN_MS)]);
      clearInterval(heartbeatTimer);
      orchestrator.stop();
      removeSignalHandlers();
      await deps.onStopped?.();
    })();
    return stopPromise;
  }

  /* ---- signal handling -------------------------------------------------- */
  const onSignal = () => {
    void stop();
  };
  const proc = (globalThis as { process?: NodeJS.Process }).process;
  function removeSignalHandlers(): void {
    proc?.off?.('SIGINT', onSignal);
    proc?.off?.('SIGTERM', onSignal);
  }
  proc?.on?.('SIGINT', onSignal);
  proc?.on?.('SIGTERM', onSignal);

  return {
    workerId,
    stop,
    done: loopsDone,
  };
}

/**
 * Derive a stable code version from env or from a hash of sorted task ids + cron.
 * Same task set + cron config → same version across processes.
 */
export function resolveCodeVersion(
  definitions: Array<ResolvedTaskDefinition<any, any>>,
): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.BETTER_TRIGGER_VERSION;
  if (env) return env;

  const signature = definitions
    .map((d) => {
      const cron = d.cron ? `${d.cron.pattern}@${d.cron.timezone ?? ''}` : '';
      return `${d.id}|${cron}`;
    })
    .sort()
    .join('\n');
  const hash = createHash('sha256').update(signature).digest('hex').slice(0, 12);
  return `v_${hash}`;
}

/** Multiply a delay by [0.8, 1.2) so idle slots do not poll in lockstep. */
function jittered(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}
