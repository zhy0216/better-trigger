/* =============================================================================
   Better Trigger — data hooks. Plain useEffect + useState + self-rescheduling
   setTimeout polling (2s), no extra deps. No mock fallback: when the server is
   unreachable the hooks surface an error (screens render it) and keep polling
   so the UI recovers as soon as the server comes back.
   useConnection() exposes the aggregate state so the UI can show a live dot.
   ============================================================================= */
import React from 'react';
import { api, ApiError, getApiKeyVersion, subscribeApiKey, type RunFilters, type RunDetailResponse, type RunLog } from './client';
import {
  adaptTasks,
  adaptRuns,
  adaptRunDetail,
  adaptSchedules,
  type AdaptedRunDetail,
} from './adapter';
import { appendTailPage, mergeRunPages } from './mergeRuns';
import type { Task, Run, Schedule } from '../types';
import type { WorkerSummary } from './client';

const POLL_MS = 2000;

/* ---- module-level connection state ---------------------------------------- */
// 'connecting' until the first response, then tracks the latest poll outcome.
export type Connection = 'connecting' | 'live' | 'down' | 'unauthorized';
let connection: Connection = 'connecting';
const listeners = new Set<() => void>();

function setConnection(next: Connection) {
  if (connection !== next) {
    connection = next;
    listeners.forEach((l) => l());
  }
}

export function resetConnection(): void {
  setConnection('connecting');
}

export function getConnection(): Connection {
  return connection;
}

export function classifyConnectionError(error: unknown): Connection {
  return error instanceof ApiError && error.status === 401 ? 'unauthorized' : 'down';
}

export function recordConnectionError(error: unknown): void {
  setConnection(classifyConnectionError(error));
}

function useApiKeyVersion(): number {
  return React.useSyncExternalStore(subscribeApiKey, getApiKeyVersion, getApiKeyVersion);
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
 * Poll `fetcher` every 2s. Failures set `error` but never stop the loop —
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
  const apiKeyVersion = useApiKeyVersion();
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
    // Paused: hold whatever data we have, issue no request, run no timer.
    // enabled false→true re-arms this effect, which doubles as the immediate
    // refresh on resume.
    if (!enabled) return;
    let mounted = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout>;

    // Self-rescheduling setTimeout: the next poll only starts once this one
    // settles, so a slow response is never interrupted and never overlaps.
    const run = async () => {
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
        // Only the effect cleanup aborts (unmount / deps change / enabled
        // flip); when that fires mid-flight `mounted` is already false, so a
        // silent return here is safe — the mounted guard swallowed it.
        if (e instanceof Error && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message || 'request failed' : 'request failed');
        setLoading(false);
        recordConnectionError(e);
      } finally {
        if (mounted) timer = setTimeout(run, POLL_MS);
      }
    };

    void run();

    return () => {
      mounted = false;
      controller?.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, apiKeyVersion]);

  return { data, loading, error };
}

/* ---- public hooks -------------------------------------------------------- */

export function useTasks(): PollResult<Task[]> {
  return usePoll<Task[]>(
    async (signal) => adaptTasks((await api.tasks(signal)).tasks),
    [],
  );
}

export interface RunsResult extends PollResult<Run[]> {
  /** Fetch the next (older) page and append it to the list. Resolves false
   *  when the server said there is no next page (or the request failed). */
  loadMore: () => Promise<boolean>;
  /** True while a loadMore request is in flight (drives the button). */
  loadingMore: boolean;
  /** False once the server reported no further pages — all runs loaded. */
  hasMore: boolean;
}

/**
 * PF3: the runs list consumes the server's keyset `nextCursor` instead of
 * forever showing only the first page. Page 1 is still polled every 2s (the
 * live head), while appended pages live in separate state so a poll tick
 * replaces the head without wiping them — a "load more" reading view, not a
 * cursor that must survive refreshes.
 */
export function useRuns(
  env: string,
  filters: RunFilters = {},
  enabled: boolean = true,
): RunsResult {
  const status = filters.status;
  const taskId = filters.taskId;
  const pageLimit = filters.limit ?? 50;

  const base = usePoll<{ runs: Run[]; nextCursor: string | null }>(
    async (signal) => {
      const res = await api.runs({ env, status, taskId, limit: pageLimit }, signal);
      return { runs: adaptRuns(res.runs), nextCursor: res.nextCursor };
    },
    [env, status, taskId, pageLimit],
    enabled,
  );

  const [tail, setTail] = React.useState<Run[]>([]);
  // Continuation cursor for the tail pages, INDEPENDENT of the polled head:
  //   undefined  paging not started — the first loadMore uses the head's cursor
  //   null       started and exhausted — no more pages
  //   string     the last loaded page's cursor
  // The head poll must never touch it (see the loadMore comment below).
  const [tailCursor, setTailCursor] = React.useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = React.useState(false);

  // The polled head's own keyset. It only answers "are there more runs at
  // all" BEFORE paging has started — once the user has loaded an older page,
  // head movement must not re-open paging: a fresh run advancing the head
  // would reset a tail cursor that had gone null, and the next loadMore would
  // fetch runs NEWER than the tail and append them out of order
  // ("...2,1,51" after the list had finished). The price is that runs that
  // slide off the head into the gap are only reachable by refreshing filters.
  const headHasMore = (base.data?.nextCursor ?? null) !== null;

  // A filter/env change invalidates appended pages — they were loaded for the
  // previous query.
  const depsKey = JSON.stringify([env, status, taskId, pageLimit]);
  React.useEffect(() => {
    setTail([]);
    setTailCursor(undefined);
    setLoadingMore(false);
  }, [depsKey]);

  const loadMore = React.useCallback(async (): Promise<boolean> => {
    if (loadingMore || !enabled) return false;
    if (tailCursor === null) return false; // already loaded everything
    const cursor = tailCursor ?? base.data?.nextCursor ?? null;
    if (cursor === null) return false; // the head page itself was the last page
    setLoadingMore(true);
    try {
      const res = await api.runs({ env, status, taskId, limit: pageLimit, cursor });
      setTail((prev) => appendTailPage(prev, adaptRuns(res.runs)));
      // Only the user's own paging advances the tail cursor.
      setTailCursor(res.nextCursor);
      return res.nextCursor !== null;
    } catch {
      return false;
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, enabled, tailCursor, base.data?.nextCursor, env, status, taskId, pageLimit]);

  const head = base.data?.runs ?? [];
  const data = base.data === null ? null : mergeRunPages(head, tail);
  const hasMore = tailCursor === undefined ? headHasMore : tailCursor !== null;

  return {
    data,
    loading: base.loading,
    error: base.error,
    loadMore,
    loadingMore,
    hasMore,
  };
}

export interface RunDetailResult extends PollResult<AdaptedRunDetail> {
  /** Fetch the next (older) log page and append it to the log stream.
   *  Resolves false when there is no older page (or the request failed). */
  loadOlderLogs: () => Promise<boolean>;
  /** True while a loadOlderLogs request is in flight (drives the button). */
  loadingOlderLogs: boolean;
  /** False once the server reported no older logs — all logs loaded. */
  hasOlderLogs: boolean;
}

/**
 * PF3 logs paging: the detail endpoint serves the newest 200 log lines with a
 * `logsNextCursor` when older ones exist; this hook walks that chain. The
 * polled head stays the newest page, appended pages live in separate state
 * (keyed off their own cursors), and the combined stream is deduped by log id
 * — a head that slides forward between polls must not duplicate a line.
 */
export function useRun(runId: string | null): RunDetailResult {
  const base = usePoll<RunDetailResponse>(
    async (signal) => api.run(runId!, undefined, signal),
    [runId],
    runId !== null,
  );

  const [olderLogs, setOlderLogs] = React.useState<RunLog[]>([]);
  // Continuation cursor for the older pages, INDEPENDENT of the polled head:
  //   undefined  paging not started — the first load uses the head's cursor
  //   null       started and exhausted — no older page
  //   number     the last loaded page's cursor
  const [olderCursor, setOlderCursor] = React.useState<number | null | undefined>(undefined);
  const [loadingOlderLogs, setLoadingOlderLogs] = React.useState(false);

  // A runId change invalidates loaded pages (RunDetail is keyed by runId, so
  // this is belt-and-braces for the same effect).
  React.useEffect(() => {
    setOlderLogs([]);
    setOlderCursor(undefined);
    setLoadingOlderLogs(false);
  }, [runId]);

  const loadOlderLogs = React.useCallback(async (): Promise<boolean> => {
    if (runId == null || loadingOlderLogs) return false;
    if (olderCursor === null) return false; // already loaded everything
    const cursor = olderCursor ?? base.data?.logsNextCursor ?? null;
    if (cursor === null) return false; // the head page itself has no older logs
    setLoadingOlderLogs(true);
    try {
      const res = await api.run(runId, { logsBefore: cursor });
      // Append the older page; the head may have slid forward between polls,
      // so rows the newer pages already carry are dropped (dedupe by log id).
      setOlderLogs((prev) => {
        const seen = new Set(prev.map((l) => l.id));
        return [...prev, ...res.logs.filter((l) => !seen.has(l.id))];
      });
      setOlderCursor(res.logsNextCursor);
      return res.logsNextCursor !== null;
    } catch {
      return false;
    } finally {
      setLoadingOlderLogs(false);
    }
  }, [runId, loadingOlderLogs, olderCursor, base.data?.logsNextCursor]);

  const data = React.useMemo<AdaptedRunDetail | null>(() => {
    if (base.data === null) return null;
    const seen = new Set<number>();
    const unique = [...base.data.logs, ...olderLogs].filter((l) => !seen.has(l.id) && seen.add(l.id));
    return adaptRunDetail({ ...base.data, logs: unique });
  }, [base.data, olderLogs]);

  const hasOlderLogs =
    olderCursor === undefined ? (base.data?.logsNextCursor ?? null) !== null : olderCursor !== null;

  return {
    data,
    loading: base.loading,
    error: base.error,
    loadOlderLogs,
    loadingOlderLogs,
    hasOlderLogs,
  };
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
