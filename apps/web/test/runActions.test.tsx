/* =============================================================================
   Better Trigger — RunHeader retry/cancel actions (p2-33).

   cancelRun/retryRun existed on the client but had zero call sites: a failed
   run could be inspected but never retried, a running one never canceled.
   RunHeader wires them up by run status — failed/canceled → Retry,
   queued/running/waiting → Cancel — with a disabled pending state during the
   call and an inline error on failure (the optimistic overlay rolls back and
   the useRun poll drives the real status).
   ============================================================================= */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/features/run/RunView';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';
import type { RunDetailResponse, ServerRunStatus } from '../src/api/client';

// Base timestamps relative to the REAL clock: a running run has no finishedAt,
// so adaptRunDetail sizes the waterfall from `now` (Date.now()) — a startedAt
// pinned in the past would blow up totalMs and make Ruler render ~10⁵ ticks.
const BASE = Date.now();

function detail(id: string, status: ServerRunStatus): RunDetailResponse {
  const running = status === 'running';
  return {
    run: {
      id,
      taskId: 't',
      status,
      trigger: 'api',
      codeVersion: 'v',
      projectId: 'default',
      env: 'prod',
      attempt: 1,
      maxAttempts: 3,
      durationMs: null,
      createdAt: new Date(BASE - 60_000).toISOString(),
      startedAt: new Date(BASE - 60_000).toISOString(),
      finishedAt: running ? null : new Date(BASE - 59_000).toISOString(),
      payload: null,
      output: null,
      error: null,
      parentRunId: null,
      idempotencyKey: null,
      queuedAt: new Date(BASE - 60_000).toISOString(),
    },
    steps: [],
    stepsTruncated: false,
    waits: [],
    waitsTruncated: false,
    logs: [],
    logsNextCursor: null,
  };
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, statusText: 'Mapped' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setApiKey(null);
  resetConnection();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RunHeader retry', () => {
  it('offers Retry on a failed run and calls api.retryRun', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/retry')) return Promise.resolve(json({ runId: 'r2' }, 200));
      return Promise.resolve(json(detail('r1', 'failed'), 200));
    });
    const onRetried = vi.fn();
    render(<RunView runId="r1" onRetried={onRetried} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([inp]) => String(inp).includes('/runs/r1/retry'))).toBe(true),
    );
    // retryRun mints a NEW run; the UI must hand its id to the caller (which
    // navigates to it) instead of silently staying on the old failed run.
    await waitFor(() => expect(onRetried).toHaveBeenCalledWith('r2'));
  });

  it('offers Retry on a canceled run', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(detail('r1', 'canceled'), 200)));
    render(<RunView runId="r1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });
});

describe('RunHeader cancel', () => {
  it('offers Cancel on a running run and calls api.cancelRun', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/cancel')) return Promise.resolve(json({ ok: true }, 200));
      return Promise.resolve(json(detail('r1', 'running'), 200));
    });
    render(<RunView runId="r1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([inp]) => String(inp).includes('/runs/r1/cancel'))).toBe(true),
    );
  });

  it('offers Cancel on a waiting run (server waiting → UI frozen)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(detail('r1', 'waiting'), 200)));
    render(<RunView runId="r1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy());
  });

  it('surfaces a failing cancel and does not stick (optimistic rollback)', async () => {
    let cancels = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/cancel')) {
        cancels += 1;
        return Promise.resolve(json({ error: { code: 'conflict', message: 'run is not terminal' } }, 409));
      }
      return Promise.resolve(json(detail('r1', 'running'), 200));
    });
    render(<RunView runId="r1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    // The server's error surfaces inline…
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('run is not terminal')).toBeTruthy();
    // …and the button is back to an enabled Cancel (pending rolled back).
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();
    expect((screen.getByRole('button', { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(cancels).toBe(1);
  });
});
