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
import type { RunDetailResponse, RunLog, RunsResponse, RunSummary } from '../src/api/client';

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

describe('useRun logs pagination (loadOlderLogs)', () => {
  const log = (id: number): RunLog => ({
    id,
    stepSeq: null,
    level: 'info',
    message: `line ${id}`,
    data: null,
    ts: new Date(1_000_000_000_000 + id).toISOString(),
  });

  const detail = (ids: number[], logsNextCursor: number | null): RunDetailResponse => ({
    run: {
      id: 'r1',
      taskId: 't',
      status: 'completed',
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
});
