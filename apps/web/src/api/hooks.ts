/* =============================================================================
   Better Trigger — data hooks. Plain useEffect + useState + setInterval(2s)
   polling, no extra deps. A single module-level liveness probe decides whether
   the whole app talks to the server or falls back to mock data:
     - VITE_BT_API_URL unset                 → mock
     - first /health (or first fetch) fails  → mock
   useIsLive() exposes the resolved source so the UI can show a live/mock dot.
   ============================================================================= */
import React from 'react';
import {
  api,
  API_CONFIGURED,
  type RunFilters,
  type RunDetailResponse,
} from './client';
import {
  adaptTasks,
  adaptRuns,
  adaptRunDetail,
  adaptSchedules,
  type AdaptedRunDetail,
} from './adapter';
import {
  TASKS as MOCK_TASKS,
  RUNS as MOCK_RUNS,
  SCHEDULES as MOCK_SCHEDULES,
} from '../data/mock';
import type { Task, Run, Schedule } from '../types';
import type { WorkerSummary } from './client';

const POLL_MS = 2000;
// consecutive poll failures (per live hook) before we give up and demote to mock.
const MAX_POLL_FAILURES = 5;

/* ---- module-level liveness probe ----------------------------------------- */
// 'unknown' until the first probe resolves, then 'live' | 'mock' for the session.
type Liveness = 'unknown' | 'live' | 'mock';
let liveness: Liveness = API_CONFIGURED ? 'unknown' : 'mock';
let probe: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function setLiveness(next: Exclude<Liveness, 'unknown'>) {
  if (liveness !== next) {
    liveness = next;
    notify();
  }
}

/** Probe /health once per session; cache the result. mock when unconfigured. */
function ensureProbe(): Promise<boolean> {
  if (!API_CONFIGURED) return Promise.resolve(false);
  if (liveness === 'live') return Promise.resolve(true);
  if (liveness === 'mock') return Promise.resolve(false);
  if (!probe) {
    probe = api
      .health()
      .then(() => {
        setLiveness('live');
        return true;
      })
      .catch(() => {
        setLiveness('mock');
        return false;
      });
  }
  return probe;
}

/** Mark the session as mock after a request failure (network down mid-session). */
function demoteToMock() {
  setLiveness('mock');
}

/** Subscribe to liveness changes; returns 'live' once probe confirms, else 'mock'. */
export function useIsLive(): boolean {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    listeners.add(force);
    void ensureProbe();
    return () => {
      listeners.delete(force);
    };
  }, []);
  return liveness === 'live';
}

/* ---- generic polling driver ---------------------------------------------- */
interface PollResult<T> {
  data: T;
  live: boolean;
  loading: boolean;
  error: string | null;
}

/**
 * Poll `fetcher` every 2s while live; otherwise hold `fallback`.
 * `deps` re-arms the effect (filters / id changes). `fetcher` receives an
 * AbortSignal so in-flight requests are canceled on unmount / dep change.
 */
function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  fallback: T,
  deps: React.DependencyList,
  enabled: boolean = true,
): PollResult<T> {
  const [data, setData] = React.useState<T>(fallback);
  const [live, setLive] = React.useState(liveness === 'live');
  const [loading, setLoading] = React.useState(liveness !== 'mock');
  const [error, setError] = React.useState<string | null>(null);
  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;

  React.useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let controller: AbortController | null = null;
    // whether this hook has ever received live data (survives across polls).
    let everLive = false;
    // consecutive poll failures since the last success.
    let failures = 0;

    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const out = await fetcherRef.current(controller.signal);
        if (!mounted) return;
        everLive = true;
        failures = 0;
        setData(out);
        setLive(true);
        setError(null);
        setLoading(false);
      } catch (e) {
        if (!mounted) return;
        if ((e as { name?: string }).name === 'AbortError') return;
        failures += 1;
        const message = (e as Error).message || 'request failed';
        // First-frame failure (never got live data) → demote to mock immediately:
        // this is indistinguishable from the server being unavailable at startup.
        if (!everLive) {
          demoteToMock();
          setData(fallback);
          setLive(false);
          setError(message);
          setLoading(false);
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          return;
        }
        // Already live → a transient failure must not flash real data to mock.
        // Hold the last frame; only after MAX_POLL_FAILURES in a row do we demote.
        setError(message);
        if (failures >= MAX_POLL_FAILURES) {
          demoteToMock();
          setData(fallback);
          setLive(false);
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        }
      }
    };

    const start = async () => {
      // Paused: hold whatever data we have, issue no request, run no interval.
      if (!enabled) return;
      const ok = await ensureProbe();
      if (!mounted) return;
      if (!ok) {
        setData(fallback);
        setLive(false);
        setLoading(false);
        return;
      }
      // enabled false→true re-arms this effect, so this also serves as the
      // immediate refresh when resuming.
      await run();
      if (!mounted) return;
      timer = setInterval(run, POLL_MS);
    };

    void start();

    return () => {
      mounted = false;
      controller?.abort();
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  return { data, live, loading, error };
}

/* ---- public hooks -------------------------------------------------------- */

export function useTasks(): PollResult<Task[]> {
  return usePoll<Task[]>(
    async (signal) => adaptTasks((await api.tasks(signal)).tasks),
    MOCK_TASKS,
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
    MOCK_RUNS,
    [env, status, taskId, limit],
    enabled,
  );
}

export function useRun(runId: string | null): PollResult<AdaptedRunDetail | null> {
  return usePoll<AdaptedRunDetail | null>(
    async (signal) => {
      if (!runId) return null;
      const detail: RunDetailResponse = await api.run(runId, signal);
      return adaptRunDetail(detail);
    },
    null,
    [runId],
  );
}

export function useSchedules(): PollResult<Schedule[]> {
  return usePoll<Schedule[]>(
    async (signal) => adaptSchedules((await api.schedules(signal)).schedules),
    MOCK_SCHEDULES,
    [],
  );
}

export function useWorkers(): PollResult<WorkerSummary[]> {
  return usePoll<WorkerSummary[]>(
    async (signal) => (await api.workers(signal)).workers,
    [],
    [],
  );
}

export { api } from './client';
