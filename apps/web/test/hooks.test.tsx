/* =============================================================================
   Better Trigger — data-hook behaviour tests (O5).

   usePoll is the dashboard's polling driver: initial fetch, a 2s interval,
   failures surface an error and flip the connection to 'down' WITHOUT
   stopping the loop (the next successful tick must clear the error), and
   unmount aborts the in-flight request. useRuns layers the keyset pagination
   on top: loadMore appends strictly-older pages until the cursor runs out,
   and a filter/env change must drop the appended tail.

   Rendered with @testing-library/react under jsdom; fake timers drive the
   2s interval deterministically.
   ============================================================================= */
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiKey } from '../src/api/client';
import { getConnection, resetConnection, useRun, useRuns, useSchedules, useTasks } from '../src/api/hooks';
import type { RunDetailResponse, RunLog, RunsResponse, RunSummary, ServerRunStatus } from '../src/api/client';

const run = (id: string): RunSummary => ({
  id,
  taskId: 't',
  status: 'completed',
  trigger: 'api',
  codeVersion: 'v',
  env: 'prod',
  attempt: 1,
  durationMs: null,
  createdAt: '2026-08-11T10:00:00Z',
  startedAt: null,
  finishedAt: null,
});

const page = (ids: string[], nextCursor: string | null): RunsResponse => ({
  runs: ids.map(run),
  nextCursor,
});

const res = (body: RunsResponse): Response =>
  new Response(JSON.stringify(body), { status: 200 });

/** Flush pending microtasks inside act (fake timers + resolved fetches). */
async function flush(): Promise<void> {
  await act(async () => {});
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  setApiKey(null);
  resetConnection();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

describe('usePoll (via useRuns)', () => {
  it('fetches immediately and re-polls the head every 2s', async () => {
    fetchMock
      .mockResolvedValueOnce(res(page(['a0'], 'c1')))
      .mockImplementation(() => res(page(['b0'], 'c2')));
    const { result } = renderHook(() => useRuns('prod'));

    await flush();
    expect(result.current.data?.map((r) => r.id)).toEqual(['a0']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.data?.map((r) => r.id)).toEqual(['b0']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the error and a down connection, then recovers on the next tick', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(() => res(page(['a0'], null)));
    const { result } = renderHook(() => useRuns('prod'));

    await flush();
    expect(result.current.error).toBeTruthy();
    expect(result.current.data).toBeNull();
    expect(getConnection()).toBe('down');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.data?.map((r) => r.id)).toEqual(['a0']);
    expect(getConnection()).toBe('live');
  });

  it('keeps polling while the server is down — the loop never stops', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useRuns('prod'));

    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    // initial + 3 interval ticks, all failing, error still surfaced.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.current.error).toBeTruthy();
    expect(result.current.loading).toBe(false);
  });

  it('never interrupts or overlaps a slow (>2s) response, and resumes polling after it lands', async () => {
    fetchMock
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(res(page(['slow'], null))), 6000)),
      )
      .mockImplementation(() => res(page(['b0'], 'c2')));
    const { result } = renderHook(() => useRuns('prod'));

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    // The slow response landed — it was NOT aborted by a 2s tick.
    expect(result.current.data?.map((r) => r.id)).toEqual(['slow']);
    expect(result.current.loading).toBe(false);
    // No second request fired during the slow fetch (no overlap).
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // The loop resumed after the slow response settled.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.map((r) => r.id)).toEqual(['b0']);
  });

  it('unmount aborts the in-flight request', async () => {
    let captured: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => {
      captured = init?.signal;
      return new Promise(() => {}); // never settles — like a hung server
    });
    const { unmount } = renderHook(() => useRuns('prod'));
    await flush();
    expect(captured?.aborted).toBe(false);
    unmount();
    expect(captured?.aborted).toBe(true);
  });

  it('pauses polling while the page is hidden and refreshes immediately on visibility (C2)', async () => {
    fetchMock.mockImplementation(() => res(page(['a0'], null)));
    // Hidden before the first fetch settles → its `finally` never schedules the
    // next tick, so a hidden tab stops polling (only the initial fetch runs).
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    const { result } = renderHook(() => useRuns('prod'));

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    // Still hidden: no further polls were scheduled.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The tab becomes visible again → an immediate catch-up request.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.map((r) => r.id)).toEqual(['a0']);
  });
});

describe('useRuns pagination (loadMore)', () => {
  it('appends older pages via the keyset cursor and stops at the end', async () => {
    fetchMock
      .mockResolvedValueOnce(res(page(['a1', 'a0'], 'c1'))) // head, more exist
      .mockImplementation(() => res(page(['b1', 'b0'], null))); // older page, exhausted
    const { result } = renderHook(() => useRuns('prod'));

    await flush();
    expect(result.current.hasMore).toBe(true);
    expect(result.current.data?.map((r) => r.id)).toEqual(['a1', 'a0']);

    let more: boolean | undefined;
    await act(async () => {
      more = await result.current.loadMore();
    });
    expect(more).toBe(false);
    expect(result.current.data?.map((r) => r.id)).toEqual(['a1', 'a0', 'b1', 'b0']);
    expect(result.current.hasMore).toBe(false);

    // The tail is exhausted: another loadMore must not hit the network.
    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      more = await result.current.loadMore();
    });
    expect(more).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('keeps the appended tail across a head poll tick', async () => {
    fetchMock
      .mockResolvedValueOnce(res(page(['a1', 'a0'], 'c1'))) // initial head
      .mockImplementationOnce(() => res(page(['b1', 'b0'], null))) // loadMore page
      .mockImplementation(() => res(page(['a1', 'a0'], 'c1'))); // later ticks: live head again
    const { result } = renderHook(() => useRuns('prod'));

    await flush();
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.data).toHaveLength(4);

    // A live-head poll replaces the head only; the tail survives (mergeRuns).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.data?.map((r) => r.id)).toEqual(['a1', 'a0', 'b1', 'b0']);
  });

  it('drops the appended tail when env/filters change', async () => {
    fetchMock
      .mockResolvedValueOnce(res(page(['a1', 'a0'], 'c1')))
      .mockImplementationOnce(() => res(page(['b1', 'b0'], null)))
      .mockImplementation(() => res(page(['a1', 'a0'], 'c1')));
    const { result, rerender } = renderHook(({ env }: { env: string }) => useRuns(env), {
      initialProps: { env: 'prod' },
    });

    await flush();
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.data).toHaveLength(4);

    rerender({ env: 'staging' });
    await flush();
    // New query: head only for staging (the stub answers the same page).
    expect(result.current.data?.map((r) => r.id)).toEqual(['a1', 'a0']);
    expect(result.current.hasMore).toBe(true); // paging re-armed
  });

  it('distinguishes a failed loadMore from an exhausted list (C3)', async () => {
    fetchMock
      .mockResolvedValueOnce(res(page(['a1', 'a0'], 'c1')))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useRuns('prod'));

    await flush();
    expect(result.current.loadMoreError).toBeNull();

    let more: boolean | undefined;
    await act(async () => {
      more = await result.current.loadMore();
    });
    expect(more).toBe(false);
    expect(result.current.loadMoreError).toBe('Failed to fetch');
    // A failed request must not read as "no more": paging stays re-armed so a
    // re-click can retry.
    expect(result.current.hasMore).toBe(true);
  });

  it('drops an in-flight loadMore when env changes before it lands (P1-17 C1)', async () => {
    let resolveTail: ((r: Response) => void) | undefined;
    const tail = new Promise<Response>((r) => {
      resolveTail = r;
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      // The prod page-2 request hangs; every head answers the same first page.
      if (u.includes('cursor=')) return tail;
      return Promise.resolve(res(page(['a1', 'a0'], 'c1')));
    });
    const { result, rerender } = renderHook(({ env }: { env: string }) => useRuns(env), {
      initialProps: { env: 'prod' },
    });

    await flush();
    expect(result.current.hasMore).toBe(true);

    act(() => {
      void result.current.loadMore();
    });
    expect(result.current.loadingMore).toBe(true);

    // The user switches env while the page is still in flight…
    rerender({ env: 'staging' });
    await flush();
    // …then the OLD prod response lands: its rows must never enter the
    // staging list (before the guard they were appended into the new query).
    await act(async () => {
      resolveTail!(res(page(['stale'], null)));
    });
    expect(result.current.data?.map((r) => r.id)).toEqual(['a1', 'a0']);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.hasMore).toBe(true); // staging paging still armed
    expect(result.current.loadMoreError).toBeNull();
  });

  it('a stale loadMore landing during a fresh one neither appends rows nor clears the new spinner (P1-17 C1)', async () => {
    let resolveProd: ((r: Response) => void) | undefined;
    let resolveStaging: ((r: Response) => void) | undefined;
    const prodTail = new Promise<Response>((r) => {
      resolveProd = r;
    });
    const stagingTail = new Promise<Response>((r) => {
      resolveStaging = r;
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('cursor=')) return u.includes('env=prod') ? prodTail : stagingTail;
      return Promise.resolve(res(page(['a1', 'a0'], 'c1')));
    });
    const { result, rerender } = renderHook(({ env }: { env: string }) => useRuns(env), {
      initialProps: { env: 'prod' },
    });

    await flush();
    act(() => {
      void result.current.loadMore();
    });
    // Env switches mid-flight; the fresh staging loadMore starts while the
    // prod page is still pending.
    rerender({ env: 'staging' });
    await flush();
    act(() => {
      void result.current.loadMore();
    });
    expect(result.current.loadingMore).toBe(true);

    // The stale prod page resolves first: it must not append its rows and
    // must not clear the spinner the staging request still owns.
    await act(async () => {
      resolveProd!(res(page(['stale'], null)));
    });
    expect(result.current.loadingMore).toBe(true);
    expect(result.current.data?.map((r) => r.id)).toEqual(['a1', 'a0']);

    await act(async () => {
      resolveStaging!(res(page(['s1'], null)));
    });
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.data?.map((r) => r.id)).toEqual(['a1', 'a0', 's1']);
  });
});

describe('connection aggregation — one flaky poll must not flip the dot', () => {
  function Harness() {
    useRuns('prod');
    useTasks();
    useSchedules();
    return null;
  }

  it('stays live while one of three polls fails, and only goes down when ALL fail', async () => {
    const schedule = {
      id: 's', taskId: 't', cronPattern: '*/5 * * * *', cronTz: null, enabled: true,
      nextRunAt: null, lastRunAt: null, lastRunStatus: null,
    };
    const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
    const boom = (): Response =>
      new Response(JSON.stringify({ error: { code: 'internal_error', message: 'boom' } }), { status: 500 });
    // The /tasks poll keeps failing while runs+schedules stay healthy; when
    // allFail flips, every endpoint fails.
    let allFail = false;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      // Fresh Response per call: a Response body can only be consumed once.
      if (allFail) return Promise.resolve(boom());
      if (u.includes('/tasks')) return Promise.resolve(boom());
      if (u.includes('/schedules')) return Promise.resolve(ok({ schedules: [schedule] }));
      return Promise.resolve(ok({ runs: [run('a0')], nextCursor: null }));
    });

    render(<Harness />);
    await flush();
    // The tasks endpoint 500s but runs+schedules are healthy → still live, no
    // flicker to 'down'.
    expect(getConnection()).toBe('live');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // The bad poll keeps failing; the healthy ones keep winning.
    expect(getConnection()).toBe('live');

    allFail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // Every poll now fails → the aggregate genuinely goes down.
    expect(getConnection()).toBe('down');

    allFail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // One healthy endpoint is enough to bring it back up.
    expect(getConnection()).toBe('live');
  });

  it('an unauthorized outcome wins over still-in-flight polls (p1-20)', async () => {
    const auth = (): Response =>
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'bad key' } }), {
        status: 401,
      });
    // The runs poll (registered FIRST) 401s immediately; tasks+schedules
    // mount AFTER it and stay in flight (never resolve). Without the fix, the
    // later-registered in-flight entries (outcome null) would be the "newest"
    // and mask the unauthorized outcome → 'connecting'. The aggregate must
    // surface 'unauthorized' (the key prompt).
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/runs')) return Promise.resolve(auth());
      return new Promise(() => {}); // tasks + schedules: in-flight forever
    });

    render(<Harness />);
    await flush();
    expect(getConnection()).toBe('unauthorized');
  });
});

const log = (id: number): RunLog => ({
  id,
  stepSeq: null,
  level: 'info',
  message: `line ${id}`,
  data: null,
  ts: new Date(1_000_000_000_000 + id).toISOString(),
});

const detail = (ids: number[], logsNextCursor: number | null, status: ServerRunStatus = 'completed'): RunDetailResponse => ({
  run: {
    id: 'r1',
    taskId: 't',
    status,
    trigger: 'api',
    codeVersion: 'v',
    projectId: 'default',
    env: 'prod',
    attempt: 1,
    maxAttempts: 1,
    durationMs: null,
    createdAt: '2026-08-11T10:00:00Z',
    startedAt: '2026-08-11T10:00:00Z',
    finishedAt: '2026-08-11T10:00:01Z',
    payload: null,
    output: null,
    error: null,
    parentRunId: null,
    idempotencyKey: null,
    queuedAt: '2026-08-11T10:00:00Z',
  },
  steps: [],
  stepsTruncated: false,
  waits: [],
  waitsTruncated: false,
  logs: ids.map(log),
  logsNextCursor,
});

describe('useRun logs pagination (loadOlderLogs)', () => {
  it('appends the older page via logsBefore, dedupes the overlap, and exhausts', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      // Head page: ids 201..220, cursor 201. Older page: ids 1..210 (ids
      // 201..210 overlap the head — the head slid forward between polls),
      // cursor null — earliest page.
      const ids = u.includes('logsBefore=201')
        ? Array.from({ length: 210 }, (_, i) => i + 1)
        : Array.from({ length: 20 }, (_, i) => i + 201);
      return Promise.resolve(
        new Response(
          JSON.stringify(detail(ids, u.includes('logsBefore=') ? null : 201)),
          { status: 200 },
        ),
      );
    });
    const { result } = renderHook(() => useRun('r1'));

    await flush();
    // 20 head lines; older logs exist.
    expect(result.current.data?.spanLogs.s0).toHaveLength(20);
    expect(result.current.hasOlderLogs).toBe(true);

    let more: boolean | undefined;
    await act(async () => {
      more = await result.current.loadOlderLogs();
    });
    // 20 + 210 − 10 overlapping = 220 unique lines.
    expect(more).toBe(false);
    expect(result.current.data?.spanLogs.s0).toHaveLength(220);
    expect(result.current.hasOlderLogs).toBe(false);
    // The request carried the head's cursor as logsBefore.
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('logsBefore=201');

    // Exhausted: another load must not hit the network.
    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      more = await result.current.loadOlderLogs();
    });
    expect(more).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('distinguishes a failed loadOlderLogs from exhausted logs (C3)', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('logsBefore=')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(
        new Response(JSON.stringify(detail([201], 201)), { status: 200 }),
      );
    });
    const { result } = renderHook(() => useRun('r1'));

    await flush();
    expect(result.current.loadOlderLogsError).toBeNull();

    let more: boolean | undefined;
    await act(async () => {
      more = await result.current.loadOlderLogs();
    });
    expect(more).toBe(false);
    expect(result.current.loadOlderLogsError).toBe('Failed to fetch');
    expect(result.current.hasOlderLogs).toBe(true); // a failure ≠ than "no more"
  });

  it('drops an in-flight loadOlderLogs when the run changes before it lands (P1-17 C1)', async () => {
    let resolveOlder: ((r: Response) => void) | undefined;
    const older = new Promise<Response>((r) => {
      resolveOlder = r;
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      // The older-page request hangs; each run's head carries a distinct line.
      if (u.includes('logsBefore=')) return older;
      const body = u.includes('/runs/r2') ? detail([301], 301) : detail([201], 201);
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const { result, rerender } = renderHook(({ runId }: { runId: string }) => useRun(runId), {
      initialProps: { runId: 'r1' },
    });

    await flush();
    expect(result.current.data?.spanLogs.s0).toHaveLength(1);

    act(() => {
      void result.current.loadOlderLogs();
    });
    expect(result.current.loadingOlderLogs).toBe(true);

    // The user opens a different run while the page is still in flight…
    rerender({ runId: 'r2' });
    await flush();
    expect(result.current.data?.spanLogs.s0).toHaveLength(1); // r2's own head
    // …then the abandoned r1 page lands: its lines must not splice into r2.
    await act(async () => {
      resolveOlder!(new Response(JSON.stringify(detail([1, 2, 3], null)), { status: 200 }));
    });
    expect(result.current.data?.spanLogs.s0).toHaveLength(1);
    expect(result.current.data?.spanLogs.s0?.[0]?.[1]).toBe('line 301');
    expect(result.current.loadingOlderLogs).toBe(false);
    expect(result.current.hasOlderLogs).toBe(true); // r2 paging still armed
    expect(result.current.loadOlderLogsError).toBeNull();
  });
});

describe('useRun stops polling on a terminal run (C1)', () => {
  it('pauses once terminal, keeps the frame, and re-arms on a new runId', async () => {
    let status: ServerRunStatus = 'running';
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(detail([201], null, status)), { status: 200 })),
    );
    const { result, rerender } = renderHook(({ runId }: { runId: string }) => useRun(runId), {
      initialProps: { runId: 'r1' },
    });

    await flush();
    expect(result.current.data?.status).toBe('running');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still running → the poll keeps going.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The run completes on the next tick → terminal status flips the pause.
    status = 'completed';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.data?.status).toBe('success');
    const callsAtTerminal = fetchMock.mock.calls.length;

    // Terminal: no further requests, but the completed frame stays in view.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAtTerminal);
    expect(result.current.data?.status).toBe('success');

    // A new runId yields a different run (possibly still in flight) → re-arm.
    status = 'running';
    rerender({ runId: 'r2' });
    await flush();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAtTerminal);
  });
});

describe('usePoll survives a stalled request (T1)', () => {
  it('records the timeout as an error and keeps scheduling ticks', async () => {
    // A daemon that accepts the connection but never answers: the request only
    // settles when the client timeout aborts it. Before the fix this hung the
    // fetch forever, so the self-rescheduling loop never advanced again.
    fetchMock.mockImplementation((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
    );
    const { result } = renderHook(() => useRuns('prod'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Under the deadline: still pending, no error, loop waiting on the fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Crossing the 10s deadline aborts the fetch → a recorded poll error.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.error).toMatch(/timed out/i);
    expect(getConnection()).toBe('down');

    // The finally still re-armed the loop → the next tick polls again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
