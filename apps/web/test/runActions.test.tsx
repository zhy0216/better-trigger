/* =============================================================================
   Better Trigger — RunHeader retry/cancel actions (p2-33).

   cancelRun/retryRun existed on the client but had zero call sites: a failed
   run could be inspected but never retried, a running one never canceled.
   RunHeader wires them up by run status — failed/canceled → Retry,
   queued/running/waiting → Cancel — with a disabled pending state during the
   call and an inline error on failure (the optimistic overlay rolls back and
   the useRun poll drives the real status).
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/features/run/RunView';
import { createRetryIntentKey } from '../src/features/run/retryIntentKey';
import { setApiKey } from '../src/api/client';
import { resetConnection, getConnection } from '../src/api/hooks';
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
    // p2-38: the click carries an Idempotency-Key held for THIS intent, so a
    // re-send of the same intent resolves to the same new run server-side.
    const retryCall = fetchMock.mock.calls.find(([inp]) => String(inp).includes('/runs/r1/retry'));
    const init = retryCall?.[1] as RequestInit | undefined;
    const key = (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key!.length).toBeGreaterThan(0);
  });

  it('while a retry is pending the button is disabled, so a re-click spawns no second request', async () => {
    let retryCalls = 0;
    let retryKey: string | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (u.includes('/retry')) {
        retryCalls += 1;
        retryKey = (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
        // Never settle — the intent stays pending for the whole test.
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(json(detail('r1', 'failed'), 200));
    });
    render(<RunView runId="r1" />);

    const btn = await waitFor(
      () => screen.getByRole('button', { name: /retry/i }) as HTMLButtonElement,
    );
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.textContent).toMatch(/Retrying/i);

    // Re-clicks during pending are swallowed by the disabled state — the one
    // in-flight request keeps the intent's key and nothing else is sent.
    fireEvent.click(btn);
    expect(retryCalls).toBe(1);
    expect(typeof retryKey).toBe('string');
    expect(retryKey!.length).toBeGreaterThan(0);
  });

  it('holds one key per intent: the intent holder mints once and resets on clear', () => {
    const intent = createRetryIntentKey();

    const first = intent.current();
    expect(typeof first).toBe('string');
    expect(first.length).toBeGreaterThan(0);
    // Re-sends of the SAME intent (double-click's second click, a re-send
    // while the request is still pending) reuse the key…
    expect(intent.current()).toBe(first);
    expect(intent.current()).toBe(first);
    // …and settle ends the intent: the next current() mints a fresh key.
    intent.clear();
    const second = intent.current();
    expect(second).not.toBe(first);
    intent.clear();
    expect(intent.current()).not.toBe(second);
  });

  it('clears the key when the request settles: the next click is a new intent with a fresh key', async () => {
    const retryInits: RequestInit[] = [];
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (u.includes('/retry')) {
        retryInits.push(init ?? {});
        return Promise.resolve(json({ runId: 'r2' }, 200));
      }
      return Promise.resolve(json(detail('r1', 'failed'), 200));
    });
    const onRetried = vi.fn();
    render(<RunView runId="r1" onRetried={onRetried} />);

    const btn = await waitFor(() => screen.getByRole('button', { name: /retry/i }) as HTMLButtonElement);
    fireEvent.click(btn);
    await waitFor(() => expect(onRetried).toHaveBeenCalledWith('r2'));

    // The first intent has settled — clicking again is a NEW intent.
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    await waitFor(() => expect(retryInits).toHaveLength(2));

    const keyOf = (init: RequestInit) =>
      (init.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
    expect(keyOf(retryInits[0])).toBeTruthy();
    expect(keyOf(retryInits[1])).toBeTruthy();
    expect(keyOf(retryInits[1])).not.toBe(keyOf(retryInits[0]));
  });

  it('a failed retry also clears the key (the retry after the error is a fresh intent)', async () => {
    const retryInits: RequestInit[] = [];
    let failFirst = true;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (u.includes('/retry')) {
        retryInits.push(init ?? {});
        if (failFirst) {
          failFirst = false;
          return Promise.resolve(json({ error: { code: 'conflict', message: 'run is not terminal' } }, 409));
        }
        return Promise.resolve(json({ runId: 'r2' }, 200));
      }
      return Promise.resolve(json(detail('r1', 'failed'), 200));
    });
    const onRetried = vi.fn();
    render(<RunView runId="r1" onRetried={onRetried} />);

    const btn = await waitFor(() => screen.getByRole('button', { name: /retry/i }) as HTMLButtonElement);
    fireEvent.click(btn);
    // The failure surfaces inline and the pending overlay rolls back…
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // …then the retry is a new intent with a new key.
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    await waitFor(() => expect(onRetried).toHaveBeenCalledWith('r2'));

    const keyOf = (init: RequestInit) =>
      (init.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
    expect(keyOf(retryInits[0])).toBeTruthy();
    expect(keyOf(retryInits[1])).toBeTruthy();
    expect(keyOf(retryInits[1])).not.toBe(keyOf(retryInits[0]));
  });

  it('offers Retry on a canceled run', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(detail('r1', 'canceled'), 200)));
    render(<RunView runId="r1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('a 401 on a control action feeds the connection registry, not just the inline error (C3)', async () => {
    // The failed run is terminal, so C1 already paused its poll and withdrew the
    // poll's registry entry — the only thing that can flip the connection to
    // 'unauthorized' is the action's recordConnectionError call.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/retry')) {
        return Promise.resolve(json({ error: { code: 'unauthorized', message: 'bad key' } }, 401));
      }
      return Promise.resolve(json(detail('r1', 'failed'), 200));
    });
    render(<RunView runId="r1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('bad key')).toBeTruthy();
    expect(getConnection()).toBe('unauthorized');
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

  it('a non-401 control failure does not flip the connection to down (C3)', async () => {
    // Only a 401 means the credential is bad; a 409/network failure is a
    // run-state or transport problem. It surfaces inline but must not push the
    // healthy poll's 'live' state to 'down' via the connection registry.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/cancel')) {
        return Promise.resolve(json({ error: { code: 'conflict', message: 'run is not terminal' } }, 409));
      }
      return Promise.resolve(json(detail('r1', 'running'), 200));
    });
    render(<RunView runId="r1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy());
    await waitFor(() => expect(getConnection()).toBe('live'));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    expect(getConnection()).toBe('live');
  });
});
