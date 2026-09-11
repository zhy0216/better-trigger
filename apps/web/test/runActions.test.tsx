/* =============================================================================
   Better Trigger — RunHeader retry/cancel actions (p2-33).

   cancelRun/retryRun existed on the client but had zero call sites: a failed
   run could be inspected but never retried, a running one never canceled.
   RunHeader wires them up by run status — failed/canceled → Retry,
   queued/running/waiting → Cancel — with a disabled pending state during the
   call and an inline error on failure (the optimistic overlay rolls back and
   the useRun poll drives the real status).
   ============================================================================= */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/features/run/RunView';
import { ApiError, setApiKey } from '../src/api/client';
import * as client from '../src/api/client';
import { resetConnection, getConnection } from '../src/api/hooks';
import * as hooks from '../src/api/hooks';
import { adaptRunDetail } from '../src/api/adapter';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('RunHeader action ownership', () => {
  for (const kind of ['retry', 'cancel'] as const) {
    const status = kind === 'retry' ? 'failed' : 'running';
    const label = kind === 'retry' ? 'Retry' : 'Cancel';
    const pendingLabel = kind === 'retry' ? 'Retrying…' : 'Canceling…';

    it(`${kind} dispatches only once for two entries in the same tick`, async () => {
      const response = deferred<Response>();
      fetchMock.mockImplementation((input: RequestInfo | URL) => String(input).includes(`/${kind}?`)
        ? response.promise : Promise.resolve(json(detail('r1', status), 200)));
      render(<RunView runId="r1" />, { reactStrictMode: true });
      const button = await screen.findByRole('button', { name: label });
      act(() => {
        fireEvent.click(button);
        fireEvent.click(button);
      });
      expect(fetchMock.mock.calls.filter(([input]) => String(input).includes(`/${kind}?`))).toHaveLength(1);
      await act(async () => { response.resolve(json({ runId: 'retried', ok: true }, 200)); });
    });

    for (const change of ['run', 'env', 'key', 'revoke', 'leave', 'unmount'] as const) {
      for (const outcome of ['success', '401'] as const) {
        it(`${kind} retires on ${change} and ignores a late ${outcome}`, async () => {
          const response = deferred<Response>();
          let signal: AbortSignal | undefined;
          fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith(`/${kind}`)) {
              signal = init?.signal ?? undefined;
              // Deliberately ignore abort: a delivered response can still race cleanup.
              return response.promise;
            }
            return Promise.resolve(json(detail(url.pathname.split('/').pop()!, status), 200));
          });
          setApiKey('synthetic-old-key');
          const onRetried = vi.fn();
          const view = render(<RunView runId="r1" onRetried={onRetried} />);
          fireEvent.click(await screen.findByRole('button', { name: label }));
          expect(signal?.aborted).toBe(false);
          if (change === 'unmount') view.unmount();
          else if (change === 'key' || change === 'revoke') {
            act(() => { setApiKey(change === 'key' ? 'synthetic-new-key' : null); });
          } else {
            view.rerender(<RunView runId={change === 'leave' ? null : change === 'run' ? 'r2' : 'r1'}
              env={change === 'env' ? 'staging' : 'prod'} onRetried={onRetried} />);
          }
          expect(signal?.aborted).toBe(true);
          if (change !== 'unmount' && change !== 'leave') await screen.findByRole('button', { name: label });
          resetConnection();
          await act(async () => {
            response.resolve(outcome === 'success' ? json({ runId: 'late-run', ok: true }, 200)
              : json({ error: { message: 'old credential rejected' } }, 401));
          });
          expect(onRetried).not.toHaveBeenCalled();
          expect(getConnection()).not.toBe('unauthorized');
          expect(screen.queryByRole('alert')).toBeNull();
          expect(screen.queryByText('Canceled')).toBeNull();
        });
      }
    }

    for (const identity of ['run', 'env', 'key'] as const) {
      it(`${kind} keeps the new pending operation when an old request settles after ${identity} A → B → A`, async () => {
        // Keep the header mounted to test its own lifecycle, independently of
        // useRun's identity-changing loading frame (which normally unmounts it).
        const frame = {
          data: adaptRunDetail(detail('r1', status)), loading: false, error: null,
          loadOlderLogs: async () => false, loadingOlderLogs: false, hasOlderLogs: false, loadOlderLogsError: null,
        };
        const query = vi.spyOn(hooks, 'useRun').mockReturnValue(frame);
        const old = deferred<Response>();
        const current = deferred<Response>();
        fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        const onRetried = vi.fn();
        const view = render(<RunView runId="r1" onRetried={onRetried} />);
        fireEvent.click(screen.getByRole('button', { name: label }));
        const oldInit = fetchMock.mock.calls[0][1] as RequestInit;
        if (identity === 'key') {
          act(() => { setApiKey('synthetic-key-b'); });
          act(() => { setApiKey(null); });
        } else if (identity === 'run') {
          // Change the trace identity in place to exercise RunHeader directly;
          // the outer RunDetail key otherwise adds another unmount boundary.
          query.mockReturnValue({ ...frame, data: adaptRunDetail(detail('r2', status)) });
          view.rerender(<RunView runId="r1" onRetried={onRetried} />);
          query.mockReturnValue(frame);
          view.rerender(<RunView runId="r1" onRetried={onRetried} />);
        } else {
          view.rerender(<RunView runId="r1" env="staging" onRetried={onRetried} />);
          view.rerender(<RunView runId="r1" env="prod" onRetried={onRetried} />);
        }
        expect(oldInit.signal?.aborted).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: label }));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const currentInit = fetchMock.mock.calls[1][1] as RequestInit;
        if (kind === 'retry') expect(currentInit.headers).not.toEqual(oldInit.headers);
        await act(async () => { old.resolve(json({ error: { message: 'retired failure' } }, 401)); });
        const button = screen.getByRole('button', { name: pendingLabel }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(currentInit.signal?.aborted).toBe(false);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(getConnection()).not.toBe('unauthorized');
        fireEvent.click(button);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await act(async () => { current.resolve(json({ runId: 'current-retry', ok: true }, 200)); });
        expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false);
        if (kind === 'retry') expect(onRetried).toHaveBeenCalledExactlyOnceWith('current-retry');
        // A completed cancel request still waits for the poll's real status.
        else expect(screen.queryByText('Canceled')).toBeNull();
      });
    }

    it(`${kind} cancels transport silently when leaving and fetch honors abort`, async () => {
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).includes(`/${kind}?`)) return Promise.resolve(json(detail('r1', status), 200));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Transport stopped', 'AbortError')), { once: true });
        });
      });
      const view = render(<RunView runId="r1" />);
      fireEvent.click(await screen.findByRole('button', { name: label }));
      await act(async () => { view.rerender(<RunView runId={null} />); });
      expect(screen.getByText('No run selected')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText('Canceled')).toBeNull();
    });
  }

  for (const outcome of ['success', '401'] as const) {
    it(`checks the credential version before React commits the changed key on ${outcome}`, async () => {
      // Delay subscription delivery to control the interval between changing
      // the external credential and React committing the replacement view.
      const notifications = new Set<() => void>();
      const subscribe = client.subscribeApiKey;
      vi.spyOn(client, 'subscribeApiKey').mockImplementation(listener => subscribe(() => { notifications.add(listener); }));
      const response = deferred<{ runId: string }>();
      const retry = vi.spyOn(hooks.api, 'retryRun').mockReturnValue(response.promise);
      fetchMock.mockImplementation(() => Promise.resolve(json(detail('r1', 'failed'), 200)));
      const onRetried = vi.fn();
      render(<RunView runId="r1" onRetried={onRetried} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
      const signal = retry.mock.calls[0][3]!;
      await act(async () => {
        setApiKey('synthetic-replacement');
        if (outcome === 'success') response.resolve({ runId: 'old-key-retry' });
        else response.reject(new ApiError(401, 'old key rejected'));
        await response.promise.catch(() => {});
        expect(signal.aborted).toBe(false);
        expect(onRetried).not.toHaveBeenCalled();
        expect(getConnection()).not.toBe('unauthorized');
      });
      act(() => { notifications.forEach(listener => listener()); });
    });
  }
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
