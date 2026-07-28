/* =============================================================================
   Better Trigger — data hooks. Plain useEffect + useState + setInterval(2s)
   polling, no extra deps. No mock fallback: when the server is unreachable the
   hooks surface an error (screens render it) and keep polling so the UI
   recovers as soon as the server comes back.
   useConnection() exposes the aggregate state so the UI can show a live dot.
   ============================================================================= */
import React from 'react';
import { api, type RunFilters, type RunDetailResponse } from './client';
import {
  adaptTasks,
  adaptRuns,
  adaptRunDetail,
  adaptSchedules,
  type AdaptedRunDetail,
} from './adapter';
import type { Task, Run, Schedule } from '../types';
import type { WorkerSummary } from './client';

const POLL_MS = 2000;

/* ---- module-level connection state ---------------------------------------- */
// 'connecting' until the first response, then tracks the latest poll outcome.
type Connection = 'connecting' | 'live' | 'down';
let connection: Connection = 'connecting';
const listeners = new Set<() => void>();

function setConnection(next: Connection) {
  if (connection !== next) {
    connection = next;
    listeners.forEach((l) => l());
  }
}

/** Subscribe to the aggregate connection state (drives the TopBar dot). */
export function useConnection(): Connection {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return connection;
}

/* ---- generic polling driver ---------------------------------------------- */
interface PollResult<T> {
  /** null until the first successful fetch; last good frame afterwards. */
  data: T | null;
  /** true until the first response (success or failure) arrives. */
  loading: boolean;
  error: string | null;
}

/**
 * Poll `fetcher` every 2s. Failures set `error` but never stop the interval —
 * the next successful poll clears the error. `deps` re-arms the effect
 * (filters / id changes). `fetcher` receives an AbortSignal so in-flight
 * requests are canceled on unmount / dep change.
 */
function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: React.DependencyList,
  enabled: boolean = true,
): PollResult<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;

  // deps change (other run / other filters) → the held frame is for the wrong
  // query; drop it during render so stale data never flashes (React's
  // derive-state-from-props pattern). `enabled` toggles deliberately excluded:
  // pausing must hold the current frame.
  const depsKey = JSON.stringify(deps);
  const lastKey = React.useRef(depsKey);
  if (lastKey.current !== depsKey) {
    lastKey.current = depsKey;
    setData(null);
    setLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    // Paused: hold whatever data we have, issue no request, run no interval.
    // enabled false→true re-arms this effect, which doubles as the immediate
    // refresh on resume.
    if (!enabled) return;
    let mounted = true;
    let controller: AbortController | null = null;

    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const out = await fetcherRef.current(controller.signal);
        if (!mounted) return;
        setData(out);
        setError(null);
        setLoading(false);
        setConnection('live');
      } catch (e) {
        if (!mounted) return;
        if ((e as { name?: string }).name === 'AbortError') return;
        setError((e as Error).message || 'request failed');
        setLoading(false);
        setConnection('down');
      }
    };

    void run();
    const timer = setInterval(run, POLL_MS);

    return () => {
      mounted = false;
      controller?.abort();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  return { data, loading, error };
}

/* ---- public hooks -------------------------------------------------------- */

export function useTasks(): PollResult<Task[]> {
  return usePoll<Task[]>(
    async (signal) => adaptTasks((await api.tasks(signal)).tasks),
    [],
  );
}

export function useRuns(
  env: string,
  filters: RunFilters = {},
  enabled: boolean = true,
): PollResult<Run[]> {
  const status = filters.status;
  const taskId = filters.taskId;
  const limit = filters.limit;
  return usePoll<Run[]>(
    async (signal) => {
      const res = await api.runs({ env, status, taskId, limit: limit ?? 50 }, signal);
      return adaptRuns(res.runs);
    },
    [env, status, taskId, limit],
    enabled,
  );
}

export function useRun(runId: string | null): PollResult<AdaptedRunDetail> {
  return usePoll<AdaptedRunDetail>(
    async (signal) => {
      const detail: RunDetailResponse = await api.run(runId!, signal);
      return adaptRunDetail(detail);
    },
    [runId],
    runId !== null,
  );
}

export function useSchedules(): PollResult<Schedule[]> {
  return usePoll<Schedule[]>(
    async (signal) => adaptSchedules((await api.schedules(signal)).schedules),
    [],
  );
}

export function useWorkers(): PollResult<WorkerSummary[]> {
  return usePoll<WorkerSummary[]>(
    async (signal) => (await api.workers(signal)).workers,
    [],
  );
}

export { api } from './client';
