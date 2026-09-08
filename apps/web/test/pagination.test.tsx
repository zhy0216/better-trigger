import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiKey, type RunDetailResponse } from '../src/api/client';
import { getConnection, resetConnection, useRun, useRuns } from '../src/api/hooks';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const run = {
  id: 'a', taskId: 't', status: 'running' as const, trigger: 'api' as const,
  codeVersion: 'v', projectId: 'default', env: 'prod', attempt: 1, maxAttempts: 1,
  durationMs: null, createdAt: '2026-09-07T10:00:00Z', startedAt: '2026-09-07T10:00:00Z',
  finishedAt: null, queuedAt: '2026-09-07T10:00:00Z', payload: null, output: null,
  error: null, parentRunId: null, idempotencyKey: null,
};

interface QueryProps {
  env: string;
  runId: string;
  status: string;
  taskId: string;
  limit: number;
  enabled: boolean;
}
const initialProps: QueryProps = { env: 'prod', runId: 'a', status: 'all', taskId: 't', limit: 50, enabled: true };

function useRunPages(props: QueryProps) {
  const result = useRuns(props.env, { status: props.status, taskId: props.taskId, limit: props.limit }, props.enabled);
  return {
    ids: result.data?.map((row) => Number(row.id)) ?? null,
    loading: result.loading, error: result.error, hasMore: result.hasMore,
    loadingMore: result.loadingMore, loadMore: result.loadMore, loadMoreError: result.loadMoreError,
  };
}

function useLogPages(props: QueryProps) {
  const result = useRun(props.runId, props.env);
  return {
    ids: result.data?.spanLogs.s0?.map((line) => line[3]) ?? null,
    loading: result.loading, error: result.error, hasMore: result.hasOlderLogs,
    loadingMore: result.loadingOlderLogs, loadMore: result.loadOlderLogs,
    loadMoreError: result.loadOlderLogsError,
  };
}

const cases = [
  {
    name: 'runs', usePages: useRunPages, cursorParam: 'cursor',
    otherQuery: { ...initialProps, status: 'failed', taskId: 'other', limit: 10 },
    response: (ids: number[], cursor: number | null) => new Response(JSON.stringify({
      runs: ids.map((id) => ({ ...run, id: String(id) })), nextCursor: cursor === null ? null : String(cursor),
    })),
  },
  {
    name: 'logs', usePages: useLogPages, cursorParam: 'logsBefore',
    otherQuery: { ...initialProps, runId: 'b' },
    response: (ids: number[], cursor: number | null) => new Response(JSON.stringify({
      run, steps: [], stepsTruncated: false, waits: [], waitsTruncated: false,
      logs: ids.map((id) => ({ id, stepSeq: null, level: 'info', message: `line ${id}`, data: null, ts: run.createdAt })),
      logsNextCursor: cursor,
    } satisfies RunDetailResponse)),
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  setApiKey('key-a');
  resetConnection();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const flush = async () => { await act(async () => {}); };
const signalAt = (index: number): AbortSignal => fetchMock.mock.calls[index][1].signal;
const cursorAt = (index: number, param: string) => new URL(fetchMock.mock.calls[index][0]).searchParams.get(param);

describe.each(cases)('$name pagination ownership', ({ usePages, response, otherQuery, cursorParam }) => {
  it.each(['key', 'env', 'query'])('accepts only the latest head after a %s A → B → A round trip', async (change) => {
    const heads = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    fetchMock.mockReturnValueOnce(heads[0].promise).mockReturnValueOnce(heads[1].promise).mockReturnValueOnce(heads[2].promise);
    const { result, rerender } = renderHook(usePages, { initialProps });
    for (let stage = 1; stage <= 2; stage++) {
      if (change === 'key') act(() => { setApiKey(stage === 1 ? 'key-b' : 'key-a'); });
      else rerender(stage === 2 ? initialProps : change === 'env' ? { ...initialProps, env: 'staging' } : otherQuery);
    }
    expect(signalAt(0).aborted).toBe(true);
    expect(signalAt(1).aborted).toBe(true);
    expect(signalAt(2).aborted).toBe(false);
    await act(async () => {
      heads[0].resolve(response([30], 30));
      heads[1].reject(new Error('retired head failed'));
    });
    expect(result.current).toMatchObject({ ids: null, loading: true, hasMore: false, error: null });
    expect(signalAt(2).aborted).toBe(false);
    await act(async () => { heads[2].resolve(response([90], 90)); });
    expect(result.current).toMatchObject({ ids: [90], loading: false, hasMore: true, error: null });
  });

  it.each(['key', 'revocation', 'env', 'query'])('retires head/tail state and in-flight pages on %s changes', async (change) => {
    const oldPage = deferred<Response>();
    const newHead = deferred<Response>();
    const newPage = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response([30], 30))
      .mockResolvedValueOnce(response([20], 20))
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newHead.promise)
      .mockReturnValueOnce(newPage.promise);
    const frames: Array<number[] | null> = [];
    const { result, rerender } = renderHook((props: QueryProps) => {
      const value = usePages(props);
      React.useLayoutEffect(() => { frames.push(value.ids); });
      return value;
    }, { initialProps });
    await flush();
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.ids).toEqual([30, 20]);
    const oldLoader = result.current.loadMore;
    let oldLoad!: Promise<boolean>;
    act(() => { oldLoad = oldLoader(); });
    expect(result.current.loadingMore).toBe(true);
    const frameCount = frames.length;

    if (change === 'key' || change === 'revocation') {
      act(() => { setApiKey(change === 'key' ? 'key-b' : null); });
    } else {
      rerender(change === 'env' ? { ...initialProps, env: 'staging' } : otherQuery);
    }
    expect(signalAt(2).aborted).toBe(true);
    expect(result.current).toMatchObject({ ids: null, loading: true, hasMore: false, loadingMore: false, error: null, loadMoreError: null });
    expect(frames.slice(frameCount)).toEqual([null]);
    expect(await oldLoader()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers?.Authorization).toBe(change === 'revocation' ? undefined : change === 'key' ? 'Bearer key-b' : 'Bearer key-a');

    await act(async () => { newHead.resolve(response([60], 60)); });
    let freshLoad!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      freshLoad = result.current.loadMore();
      duplicate = result.current.loadMore();
    });
    expect(await duplicate).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(cursorAt(4, cursorParam)).toBe('60');

    // This transport deliberately ignores cancellation. Its late success must
    // neither commit data/cursors nor release the fresh request's lock/spinner.
    await act(async () => { oldPage.resolve(response([10], null)); });
    expect(await oldLoad).toBe(false);
    expect(result.current).toMatchObject({ ids: [60], loadingMore: true, hasMore: true, loadMoreError: null });
    expect(signalAt(4).aborted).toBe(false);
    expect(await result.current.loadMore()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await act(async () => { newPage.resolve(response([60, 50], 50)); });
    expect(await freshLoad).toBe(true);
    expect(result.current.ids).toEqual([60, 50]);
    fetchMock.mockResolvedValueOnce(response([50, 40], null));
    await act(async () => { await result.current.loadMore(); });
    expect(cursorAt(5, cursorParam)).toBe('50');
    expect(result.current).toMatchObject({ ids: [60, 50, 40], hasMore: false, loadingMore: false });

    // Head movement cannot re-open an exhausted tail or reorder loaded data.
    fetchMock.mockResolvedValueOnce(response([100, 60], 60));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current).toMatchObject({ ids: [100, 60, 50, 40], hasMore: false });
    expect(await result.current.loadMore()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it.each(['key', 'env', 'query'])('rejects pages across a %s A → B → A round trip, including late failures', async (change) => {
    const pages = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let stage = 0;
    fetchMock.mockImplementation((url: string) => new URL(url).searchParams.has(cursorParam)
      ? pages[stage].promise : Promise.resolve(response([30 + 30 * stage], 30 + 30 * stage)));
    const { result, rerender } = renderHook(usePages, { initialProps });
    await flush();
    const loads: Promise<boolean>[] = [];
    act(() => { loads.push(result.current.loadMore()); });
    for (stage = 1; stage <= 2; stage++) {
      if (change === 'key') act(() => { setApiKey(stage === 1 ? 'key-b' : 'key-a'); });
      else rerender(stage === 2 ? initialProps : change === 'env' ? { ...initialProps, env: 'staging' } : otherQuery);
      await flush();
      act(() => { loads.push(result.current.loadMore()); });
    }
    expect(signalAt(1).aborted).toBe(true);
    expect(signalAt(3).aborted).toBe(true);
    expect(signalAt(5).aborted).toBe(false);
    await act(async () => {
      pages[0].resolve(response([20], null));
      pages[1].reject(new Error('retired page failed'));
    });
    expect(await Promise.all(loads.slice(0, 2))).toEqual([false, false]);
    expect(result.current).toMatchObject({ ids: [90], loadingMore: true, hasMore: true, loadMoreError: null });
    expect(await result.current.loadMore()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await act(async () => { pages[2].resolve(response([80], null)); });
    expect(await loads[2]).toBe(false);
    expect(result.current).toMatchObject({ ids: [90, 80], loadingMore: false, hasMore: false, loadMoreError: null });
  });

  it('allows a failed page to retry its cursor with a synchronous single-flight lock', async () => {
    const retry = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response([30], 30))
      .mockRejectedValueOnce(new Error('page failed')).mockReturnValueOnce(retry.promise);
    const { result } = renderHook(usePages, { initialProps });
    await flush();
    await act(async () => { await result.current.loadMore(); });
    expect(result.current).toMatchObject({ ids: [30], loadMoreError: 'page failed', loadingMore: false, hasMore: true });
    let retryLoad!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      retryLoad = result.current.loadMore();
      duplicate = result.current.loadMore();
    });
    expect(await duplicate).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cursorAt(1, cursorParam)).toBe('30');
    expect(cursorAt(2, cursorParam)).toBe('30');
    expect(result.current).toMatchObject({ loadMoreError: null, loadingMore: true });
    await act(async () => { retry.resolve(response([20], null)); });
    expect(await retryLoad).toBe(false);
    expect(result.current).toMatchObject({ ids: [30, 20], hasMore: false, loadingMore: false });
  });

  it('clears both poll and page errors when credentials change', async () => {
    fetchMock.mockResolvedValueOnce(response([30], 30))
      .mockRejectedValueOnce(new Error('page failed'))
      .mockRejectedValueOnce(new Error('poll failed'));
    const { result } = renderHook(usePages, { initialProps });
    await flush();
    await act(async () => { await result.current.loadMore(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current).toMatchObject({ ids: [30], error: 'poll failed', loadMoreError: 'page failed' });
    const fresh = deferred<Response>();
    fetchMock.mockReturnValueOnce(fresh.promise);
    act(() => { setApiKey(null); });
    expect(result.current).toMatchObject({ ids: null, loading: true, error: null, loadMoreError: null, hasMore: false });
    await act(async () => { fresh.resolve(response([60], 60)); });
    expect(result.current).toMatchObject({ ids: [60], loading: false, hasMore: true });
  });

  it.each(['resolve', 'reject'])('aborts head and page on unmount and ignores their late %s', async (outcome) => {
    const tail = deferred<Response>();
    const head = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response([30], 30)).mockReturnValueOnce(tail.promise).mockReturnValueOnce(head.promise);
    const { result, unmount } = renderHook(usePages, { initialProps });
    await flush();
    let load!: Promise<boolean>;
    act(() => { load = result.current.loadMore(); });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    const held = result.current;
    unmount();
    expect(signalAt(1).aborted).toBe(true);
    expect(signalAt(2).aborted).toBe(true);
    expect(await held.loadMore()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const connection = getConnection();
    await act(async () => {
      if (outcome === 'resolve') {
        tail.resolve(response([20], null));
        head.resolve(response([60], 60));
      } else {
        tail.reject(new Error('retired page failed'));
        head.reject(new Error('retired poll failed'));
      }
    });
    expect(await load).toBe(false);
    expect(result.current).toBe(held);
    expect(getConnection()).toBe(connection);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each([
  { name: 'status', props: { ...initialProps, status: 'failed' } },
  { name: 'task', props: { ...initialProps, taskId: 'other-task' } },
  { name: 'limit', props: { ...initialProps, limit: 10 } },
])('invalidates a pending runs page when only the $name filter changes', async ({ props }) => {
  const page = deferred<Response>();
  fetchMock.mockResolvedValueOnce(cases[0].response([30], 30)).mockReturnValueOnce(page.promise)
    .mockResolvedValueOnce(cases[0].response([60], 60));
  const { result, rerender } = renderHook(useRunPages, { initialProps });
  await flush();
  let load!: Promise<boolean>;
  act(() => { load = result.current.loadMore(); });
  rerender(props);
  expect(signalAt(1).aborted).toBe(true);
  await act(async () => { page.resolve(cases[0].response([20], null)); });
  expect(await load).toBe(false);
  expect(result.current).toMatchObject({ ids: [60], hasMore: true, loadingMore: false });
});

it('preserves the current paused runs frame and tail, but clears them on key changes while paused', async () => {
  fetchMock.mockResolvedValueOnce(cases[0].response([30], 30)).mockResolvedValueOnce(cases[0].response([20], 20));
  const { result, rerender } = renderHook(useRunPages, { initialProps });
  await flush();
  await act(async () => { await result.current.loadMore(); });
  rerender({ ...initialProps, enabled: false });
  expect(result.current).toMatchObject({ ids: [30, 20], hasMore: true, loading: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(await result.current.loadMore()).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  act(() => { setApiKey('key-b'); });
  expect(result.current).toMatchObject({ ids: null, hasMore: false, loading: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fetchMock.mockResolvedValueOnce(cases[0].response([60], null));
  rerender(initialProps);
  await flush();
  expect(result.current.ids).toEqual([60]);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
