/* =============================================================================
   better-trigger — worker runtime.
   register → N concurrent long-poll dequeue loops → replay execution
            + a heartbeat loop (15s, reports running runs, honours cancels).
   Graceful shutdown on SIGINT/SIGTERM: stop pulling, drain in-flight runs.
   (docs/backend-contract.md §3.5, §4, §5.)
   ============================================================================= */
import { createHash } from 'node:crypto';
import type { DequeuedRun } from '@better-trigger/core';
import { HttpClient } from './client';
import type { SdkConfig } from './config';
import { Executor } from './executor';
import {
  toExecutorTask,
  toManifest,
  type ResolvedTaskDefinition,
  type TaskHandle,
} from './task';

export interface StartWorkerOptions {
  /** Tasks this worker can execute. */
  tasks: Array<TaskHandle<any, any>>;
  /** Server URL override (else BETTER_TRIGGER_API_URL / default). */
  apiUrl?: string;
  /** API key override (else BETTER_TRIGGER_API_KEY). */
  apiKey?: string;
  /** Number of concurrent execution slots / poll loops. Default 5. */
  concurrency?: number;
  /** Friendly worker name reported to the server. */
  name?: string;
}

/** Handle returned by startWorker(); lets callers stop it programmatically. */
export interface WorkerHandle {
  workerId: string;
  /** Resolves once the worker has fully drained and exited its loops. */
  stop(): Promise<void>;
  /** Promise that resolves when the worker stops (e.g. via signal). */
  done: Promise<void>;
}

const DEQUEUE_TIMEOUT_MS = 20_000;
const SHUTDOWN_DRAIN_MS = 30_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const concurrency = options.concurrency ?? 5;
  const perCall: Partial<SdkConfig> = {};
  if (options.apiUrl !== undefined) perCall.apiUrl = options.apiUrl;
  if (options.apiKey !== undefined) perCall.apiKey = options.apiKey;
  const client = new HttpClient(perCall);

  const definitions = options.tasks.map((t) => t.__definition);
  const taskById = new Map<string, ResolvedTaskDefinition<any, any>>();
  for (const def of definitions) taskById.set(def.id, def);

  const codeVersion = resolveCodeVersion(definitions);
  const manifests = definitions.map(toManifest);

  const registration = await client.registerWorker({
    name: options.name,
    codeVersion,
    runtime: 'self-host',
    concurrency,
    tasks: manifests,
  });
  const workerId = registration.workerId;
  const heartbeatIntervalMs = registration.heartbeatIntervalMs || 15_000;

  // Runs currently executing, keyed by run id → their Executor (for cancels).
  const inFlight = new Map<string, Executor>();
  let stopping = false;
  // Aborts in-flight long-polls on stop so the server stops polling for us
  // (otherwise an open dequeue could lock a run after this worker is gone).
  const stopController = new AbortController();

  /* ---- heartbeat loop --------------------------------------------------- */
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const res = await client.heartbeat(workerId, { runIds: [...inFlight.keys()] });
        for (const runId of res.cancelRunIds) {
          inFlight.get(runId)?.markCanceled();
        }
      } catch {
        // best-effort; the visibility timeout / reaper protects correctness
      }
    })();
  }, heartbeatIntervalMs);
  (heartbeatTimer as { unref?: () => void }).unref?.();

  /* ---- one poll-and-execute loop (a single concurrency slot) ----------- */
  async function pollLoop(): Promise<void> {
    let backoff = RECONNECT_BASE_MS;
    while (!stopping) {
      let run: DequeuedRun | null;
      try {
        const res = await client.dequeue(workerId, DEQUEUE_TIMEOUT_MS, stopController.signal);
        run = res.run;
        backoff = RECONNECT_BASE_MS; // reset on a successful poll
      } catch {
        if (stopping) break; // poll aborted by stop(); exit the loop
        // network / server error: exponential backoff before reconnecting
        await sleep(backoff);
        backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
        continue;
      }

      if (!run) continue; // long-poll returned empty; poll again

      const def = taskById.get(run.taskId);
      if (!def) {
        // Should not happen (server filters by registered tasks); skip safely.
        continue;
      }

      const executor = new Executor(client, toExecutorTask(def), run, workerId);
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

  const loops = Array.from({ length: concurrency }, () => pollLoop());
  const loopsDone = Promise.all(loops).then(() => undefined);

  /* ---- graceful shutdown ------------------------------------------------ */
  let stopPromise: Promise<void> | null = null;
  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      stopController.abort();
      clearInterval(heartbeatTimer);
      // Wait for poll loops to notice `stopping` and for in-flight runs to drain,
      // bounded by SHUTDOWN_DRAIN_MS.
      await Promise.race([loopsDone, sleep(SHUTDOWN_DRAIN_MS)]);
      removeSignalHandlers();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}
