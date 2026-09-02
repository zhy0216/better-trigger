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

/** Stable poll key from primitive parts (env/task/filter values). The caller
 *  owns the key: usePoll only ever treats it as an opaque identity, so it
 *  never has to serialize/deserialize a dependency list. */
const pollKey = (...parts: Array<string | number | null | undefined>): string =>
  parts.map((p) => p ?? '').join('\u0000');

/* ---- module-level connection state ---------------------------------------- */
// Aggregated across every mounted poll. Each usePoll registers a per-instance
// entry recording {ts, outcome}; the derived state is recomputed from the whole
// registry so one failing endpoint cannot flip the whole dashboard to 'down'
// (nor one 401 to the key prompt) while the others are healthy.
export type Connection = 'connecting' | 'live' | 'down' | 'unauthorized';
type Outcome = 'ok' | 'error' | 'unauthorized';

interface RegistryEntry {
  ts: number;
  /** null = mounted but no response yet. */
  outcome: Outcome | null;
}

const registry = new Map<string, RegistryEntry>();
const listeners = new Set<() => void>();
let nextEntryId = 0;
// Reserved entry for the imperative recordConnectionError() helper (tests and
// callers reporting a connection failure outside a mounted poll).
const MANUAL_ENTRY = 'manual';

let connection: Connection = 'connecting';

function notify(): void {
  listeners.forEach((l) => l());
}

/**
 * Derive the aggregate state from the registry:
 *  - any 'ok' entry wins → 'live' (one healthy endpoint keeps the UI alive);
 *  - otherwise the most recent outcome across entries being 'unauthorized'
 *    → 'unauthorized' (a rejected key 401s every endpoint, so the newest
 *    outcome wins when nothing is healthy);
 *  - otherwise → 'down' when every entry has failed, or the newest report is
 *    older than 2×POLL_MS (the polls stopped reporting);
 *  - otherwise → 'connecting' (fresh mounts not yet answered).
 */
function recompute(): Connection {
  if (registry.size === 0) {
    // No polls are mounted. Only an explicit resetConnection() should return
    // to 'connecting'; otherwise the polls that produced the current state
    // just unmounted (e.g. the 401 prompt replacing the whole screen), so hold
    // the state instead of oscillating between the prompt and the screen.
    return connection;
  }
  const entries = [...registry.values()];
  if (entries.some((e) => e.outcome === 'ok')) return 'live';
  // The "most recent outcome" is chosen among REPORTED entries only — a
  // still-in-flight poll (outcome null) is a live probe, not an outcome, and
  // must not mask an already-reported unauthorized/error as the newest.
  const reported = entries.filter((e) => e.outcome !== null);
  let newest: RegistryEntry | null = null;
  for (const e of reported) if (newest === null || e.ts >= newest.ts) newest = e;
  if (newest !== null && newest.outcome === 'unauthorized') return 'unauthorized';
  const stale = newest !== null && Date.now() - newest.ts >= 2 * POLL_MS;
  const allError = entries.every((e) => e.outcome === 'error');
  if (allError || stale) return 'down';
  return 'connecting';
}

function recomputeAndNotify(): void {
  const next = recompute();
  if (connection !== next) {
    connection = next;
    notify();
  }
}

function registerConnection(): string {
  const id = `poll-${nextEntryId++}`;
  registry.set(id, { ts: Date.now(), outcome: null });
  recomputeAndNotify();
  return id;
}

function unregisterConnection(id: string): void {
  registry.delete(id);
  recomputeAndNotify();
}

function reportOutcome(id: string, outcome: Outcome): void {
  registry.set(id, { ts: Date.now(), outcome });
  recomputeAndNotify();
}

/** Clear every recorded outcome and force 'connecting'; the next poll tick
 *  re-populates the registry. Unlike a transient registry-empty (polls that
 *  unmounted with the screen), this is an explicit user action — the prompt
 *  must actually go away. */
export function resetConnection(): void {
  registry.clear();
  if (connection !== 'connecting') {
    connection = 'connecting';
    notify();
  }
}

export function getConnection(): Connection {
  return connection;
}

export function classifyConnectionError(error: unknown): Connection {
  return error instanceof ApiError && error.status === 401 ? 'unauthorized' : 'down';
}

/** Imperative 401/network report from outside a poll (tests, misc callers). */
export function recordConnectionError(error: unknown): void {
  reportOutcome(MANUAL_ENTRY, classifyConnectionError(error) === 'unauthorized' ? 'unauthorized' : 'error');
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
 * the next successful poll clears the error. `queryKey` is a stable string
 * identity for the current query (built by the caller from its own primitive
 * inputs); a change re-arms the effect and drops the held frame. `fetcher`
 * receives an AbortSignal so in-flight requests are canceled on unmount /
 * key change. The fetcher is read through a ref, so it may close over the
 * latest render without being an effect dependency.
 */
function usePoll<T>(
  queryKey: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  enabled: boolean = true,
): PollResult<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const apiKeyVersion = useApiKeyVersion();
  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;

  // queryKey change (other run / other filters) → the held frame is for the
  // wrong query; drop it during render so stale data never flashes (React's
  // derive-state-from-props pattern). `enabled` toggles deliberately excluded:
  // pausing must hold the current frame.
  const lastKey = React.useRef(queryKey);
  if (lastKey.current !== queryKey) {
    lastKey.current = queryKey;
    setData(null);
    setLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    // Paused: hold whatever data we have, issue no request, run no timer.
    // enabled false→true re-arms this effect, which doubles as the immediate
    // refresh on resume.
    if (!enabled) return;
    const id = registerConnection();
    let mounted = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout>;
    // Guards a visibility-triggered refresh from overlapping the in-flight
    // poll: the self-rescheduling setTimeout chain never overlaps by design, but
    // visibilitychange fires run() directly from an event handler.
    let inFlight = false;

    // Self-rescheduling setTimeout: the next poll only starts once this one
    // settles, so a slow response is never interrupted and never overlaps.
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const out = await fetcherRef.current(controller.signal);
        if (!mounted) return;
        setData(out);
        setError(null);
        setLoading(false);
        reportOutcome(id, 'ok');
      } catch (e) {
        if (!mounted) return;
        // Only the effect cleanup aborts (unmount / key change / enabled
        // flip); when that fires mid-flight `mounted` is already false, so a
        // silent return here is safe — the mounted guard swallowed it.
        if (e instanceof Error && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message || 'request failed' : 'request failed');
        setLoading(false);
        reportOutcome(id, classifyConnectionError(e) === 'unauthorized' ? 'unauthorized' : 'error');
      } finally {
        inFlight = false;
        // Pause while the tab is hidden: only a visible page schedules the next
        // tick, so background tabs stop polling. Returning to visibility fires
        // onVisibility() to refresh immediately.
        if (mounted && !document.hidden) timer = setTimeout(run, POLL_MS);
      }
    };

    const onVisibility = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      void run();
    };

    document.addEventListener('visibilitychange', onVisibility);
    void run();

    return () => {
      mounted = false;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      unregisterConnection(id);
    };
  }, [queryKey, enabled, apiKeyVersion]);

  return { data, loading, error };
}

/* ---- public hooks -------------------------------------------------------- */

export function useTasks(env: string = 'prod'): PollResult<Task[]> {
  return usePoll<Task[]>(
    pollKey('tasks', env),
    async (signal) => adaptTasks((await api.tasks(env, signal)).tasks),
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
  /** Non-empty when the last loadMore request failed (distinct from
   *  "no more pages": hasMore stays true, the user can hit Load more again). */
  loadMoreError: string | null;
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
  // Stable identity for the whole runs query — used both by the poll and by
  // the tail-invalidation effect so they can never drift apart.
  const queryKey = pollKey('runs', env, status, taskId, pageLimit);

  const base = usePoll<{ runs: Run[]; nextCursor: string | null }>(
    queryKey,
    async (signal) => {
      const res = await api.runs({ env, status, taskId, limit: pageLimit }, signal);
      return { runs: adaptRuns(res.runs), nextCursor: res.nextCursor };
    },
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
  const [loadMoreError, setLoadMoreError] = React.useState<string | null>(null);
  // C1 (p1-17): generation counter for the query identity. The reset effect
  // below bumps it whenever env/filters change; a loadMore in flight when that
  // happens snapshots the old generation and DISCARDS its response on arrival,
  // so a slow page of the previous query can never append old-env rows to the
  // new list. A counter (not the key string) also catches prod→staging→prod
  // round trips, where the key matches again but the tail was reset.
  const pageGen = React.useRef(0);

  // The polled head's own keyset. It only answers "are there more runs at
  // all" BEFORE paging has started — once the user has loaded an older page,
  // head movement must not re-open paging: a fresh run advancing the head
  // would reset a tail cursor that had gone null, and the next loadMore would
  // fetch runs NEWER than the tail and append them out of order
  // ("...2,1,51" after the list had finished). The price is that runs that
  // slide off the head into the gap are only reachable by refreshing filters.
  const headHasMore = (base.data?.nextCursor ?? null) !== null;

  // A filter/env change invalidates appended pages — they were loaded for the
  // previous query. Bumping pageGen also retires any page still in flight
  // (see the C1 guard inside loadMore).
  React.useEffect(() => {
    pageGen.current += 1;
    setTail([]);
    setTailCursor(undefined);
    setLoadingMore(false);
    setLoadMoreError(null);
  }, [queryKey]);

  const loadMore = React.useCallback(async (): Promise<boolean> => {
    if (loadingMore || !enabled) return false;
    if (tailCursor === null) return false; // already loaded everything
    const cursor = tailCursor ?? base.data?.nextCursor ?? null;
    if (cursor === null) return false; // the head page itself was the last page
    const gen = pageGen.current;
    const stale = () => pageGen.current !== gen;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const res = await api.runs({ env, status, taskId, limit: pageLimit, cursor });
      // The query changed while this page was in flight — the reset effect
      // already dropped the tail; committing now would splice the OLD query's
      // rows into the new list.
      if (stale()) return false;
      setTail((prev) => appendTailPage(prev, adaptRuns(res.runs)));
      // Only the user's own paging advances the tail cursor.
      setTailCursor(res.nextCursor);
      return res.nextCursor !== null;
    } catch (e) {
      if (stale()) return false;
      setLoadMoreError(e instanceof Error ? e.message || 'request failed' : 'request failed');
      return false;
    } finally {
      // A stale request must not clear the NEW query's spinner either: the
      // reset effect already set loadingMore false, and a fresh loadMore for
      // the new key may be in flight right now.
      if (!stale()) setLoadingMore(false);
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
    loadMoreError,
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
  /** Non-empty when the last loadOlderLogs request failed (distinct from
   *  "no older logs": hasOlderLogs stays true, the user can retry). */
  loadOlderLogsError: string | null;
}

/**
 * PF3 logs paging: the detail endpoint serves the newest 200 log lines with a
 * `logsNextCursor` when older ones exist; this hook walks that chain. The
 * polled head stays the newest page, appended pages live in separate state
 * (keyed off their own cursors), and the combined stream is deduped by log id
 * — a head that slides forward between polls must not duplicate a line.
 */
export function useRun(runId: string | null, env: string = 'prod'): RunDetailResult {
  // C1: a terminal run never mutates in place — a retry mints a NEW id. Flip
  // this once the detail reports completed/failed/canceled and pause the poll
  // (the held terminal frame stays on screen). A runId/env change re-arms it:
  // the next run may still be in flight and must resume polling.
  const [terminal, setTerminal] = React.useState(false);

  const base = usePoll<RunDetailResponse>(
    pollKey('run', runId, env),
    async (signal) => {
      const res = await api.run(runId!, env, undefined, signal);
      if (res.run.status === 'completed' || res.run.status === 'failed' || res.run.status === 'canceled') {
        setTerminal(true);
      }
      return res;
    },
    runId !== null && !terminal,
  );

  const [olderLogs, setOlderLogs] = React.useState<RunLog[]>([]);
  // Continuation cursor for the older pages, INDEPENDENT of the polled head:
  //   undefined  paging not started — the first load uses the head's cursor
  //   null       started and exhausted — no older page
  //   number     the last loaded page's cursor
  const [olderCursor, setOlderCursor] = React.useState<number | null | undefined>(undefined);
  const [loadingOlderLogs, setLoadingOlderLogs] = React.useState(false);
  const [loadOlderLogsError, setLoadOlderLogsError] = React.useState<string | null>(null);
  // C1 (p1-17): same generation guard as useRuns.loadMore — an older-log page
  // that outlives its run/env identity is discarded instead of splicing the
  // OLD run's lines into the new run's stream.
  const pageGen = React.useRef(0);

  // A runId/env change invalidates loaded pages (RunDetail is keyed by runId,
  // so this is belt-and-braces for the same effect). Bumping pageGen also
  // retires any page still in flight (see loadOlderLogs below).
  React.useEffect(() => {
    pageGen.current += 1;
    setOlderLogs([]);
    setOlderCursor(undefined);
    setLoadingOlderLogs(false);
    setLoadOlderLogsError(null);
    setTerminal(false);
  }, [runId, env]);

  const loadOlderLogs = React.useCallback(async (): Promise<boolean> => {
    if (runId == null || loadingOlderLogs) return false;
    if (olderCursor === null) return false; // already loaded everything
    const cursor = olderCursor ?? base.data?.logsNextCursor ?? null;
    if (cursor === null) return false; // the head page itself has no older logs
    const gen = pageGen.current;
    const stale = () => pageGen.current !== gen;
    setLoadingOlderLogs(true);
    setLoadOlderLogsError(null);
    try {
      const res = await api.run(runId, env, { logsBefore: cursor });
      // The run/env changed while this page was in flight — the reset effect
      // already dropped the loaded pages; committing now would splice the OLD
      // run's lines into the new run's stream.
      if (stale()) return false;
      // Append the older page; the head may have slid forward between polls,
      // so rows the newer pages already carry are dropped (dedupe by log id).
      setOlderLogs((prev) => {
        const seen = new Set(prev.map((l) => l.id));
        return [...prev, ...res.logs.filter((l) => !seen.has(l.id))];
      });
      setOlderCursor(res.logsNextCursor);
      return res.logsNextCursor !== null;
    } catch (e) {
      if (stale()) return false;
      setLoadOlderLogsError(e instanceof Error ? e.message || 'request failed' : 'request failed');
      return false;
    } finally {
      // A stale request must not clear the NEW run's spinner either (the
      // reset effect already set it false; a fresh load may be in flight).
      if (!stale()) setLoadingOlderLogs(false);
    }
  }, [runId, env, loadingOlderLogs, olderCursor, base.data?.logsNextCursor]);

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
    loadOlderLogsError,
  };
}

export function useSchedules(env: string = 'prod'): PollResult<Schedule[]> {
  return usePoll<Schedule[]>(
    pollKey('schedules', env),
    async (signal) => adaptSchedules((await api.schedules(env, signal)).schedules),
  );
}

export function useWorkers(env: string = 'prod'): PollResult<WorkerSummary[]> {
  return usePoll<WorkerSummary[]>(
    pollKey('workers', env),
    async (signal) => (await api.workers(env, signal)).workers,
  );
}

export { api } from './client';
