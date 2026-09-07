/* =============================================================================
   Better Trigger — Schedules toggle failures (P1-17 C2).

   A failed enable/disable used to roll back the optimistic switch in silence;
   now it surfaces an inline alert (RunView's actionError pattern) and feeds a
   401 into the shared connection registry so the key prompt can take over.
   recordConnectionError is spied through a partial mock: the registry's own
   outcome semantics are already covered by hooks/runActions tests — what is
   pinned here is that the toggle wires itself into that channel, and only for
   auth rejections.

   The second block covers the optimistic-layer reconciliation (09 T1): overrides
   are cleared once a poll confirms them, concurrent toggles are serialized so a
   stale failure can't clobber a newer result (T2), and the switch carries an
   accessible name (T3).
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor, act, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Schedules } from '../src/screens/Schedules';
import { setApiKey } from '../src/api/client';
import type { ScheduleSummary } from '../src/api/client';

const { recordConnectionError } = vi.hoisted(() => ({ recordConnectionError: vi.fn() }));
vi.mock('../src/api/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/hooks')>()),
  recordConnectionError,
}));

const schedule: ScheduleSummary = {
  id: 's1',
  taskId: 't',
  cronPattern: '0 0 * * *',
  cronTz: null,
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: null,
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, statusText: 'Mapped' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  recordConnectionError.mockClear();
  setApiKey(null);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Drive one enable/disable click on the (single) schedule row. */
async function clickSwitch(): Promise<HTMLElement> {
  const row = screen.getByRole('group', { name: 't schedule' });
  const track = within(row).getByRole('switch');
  fireEvent.click(track);
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(true));
  return row;
}

function mockPatches(patchResponse: () => Promise<Response>): void {
  fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return patchResponse();
    return Promise.resolve(json({ schedules: [schedule] }, 200));
  });
}

describe('Schedules toggle errors (P1-17 C2)', () => {
  it('surfaces a failed toggle inline and rolls the optimistic switch back', async () => {
    mockPatches(() => Promise.resolve(json({ error: { code: 'internal_error', message: 'boom' } }, 500)));
    render(<Schedules env="prod" />);
    await waitFor(() => expect(screen.getByText('0 0 * * *')).toBeTruthy());
    const row = await clickSwitch();

    // The failure is shown (role=alert, like RunHeader's actionError)…
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/boom/)).toBeTruthy();
    // The visible state and accessible switch both reflect the rollback.
    expect(within(row).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(within(row).getByText('Active')).toBeTruthy();
  });

  it('a 401 on the toggle feeds the shared connection error channel (P1-17 C2)', async () => {
    mockPatches(() => Promise.resolve(json({ error: { code: 'unauthorized', message: 'bad key' } }, 401)));
    render(<Schedules env="prod" />);
    await waitFor(() => expect(screen.getByText('0 0 * * *')).toBeTruthy());
    await clickSwitch();

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/bad key/)).toBeTruthy();
    expect(recordConnectionError).toHaveBeenCalledTimes(1);
    const reported = recordConnectionError.mock.calls[0][0] as { status?: number };
    expect(reported?.status).toBe(401);
  });

  it('a non-401 failure surfaces inline but never touches the connection channel', async () => {
    mockPatches(() => Promise.resolve(json({ error: { code: 'not_found', message: 'gone' } }, 404)));
    render(<Schedules env="prod" />);
    await waitFor(() => expect(screen.getByText('0 0 * * *')).toBeTruthy());
    await clickSwitch();

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(recordConnectionError).not.toHaveBeenCalled();
  });

  it('a successful toggle shows no alert', async () => {
    mockPatches(() => Promise.resolve(json({ ok: true }, 200)));
    render(<Schedules env="prod" />);
    await waitFor(() => expect(screen.getByText('0 0 * * *')).toBeTruthy());
    await clickSwitch();
    // Nothing to await server-side beyond the PATCH: assert no alert appeared
    // after the microtasks have drained.
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(true));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/* ---- P1 reconciliation / P2 serialization / P2 accessible name (09) -------- */

describe('Schedules optimistic reconciliation (09 T1–T3)', () => {
  afterEach(() => vi.useRealTimers());

  const flush = () => act(async () => {});
  const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const isOn = () => (screen.getByRole('switch') as HTMLElement).getAttribute('aria-checked') === 'true';

  /** Mock that behaves like a server: GET reflects the last applied PATCH. */
  function modelServer(initial: boolean): { enabled: boolean } {
    const state = { enabled: initial };
    fetchMock.mockImplementation((_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        state.enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
        return Promise.resolve(json({ ok: true }, 200));
      }
      return Promise.resolve(json({ schedules: [{ ...schedule, enabled: state.enabled }] }, 200));
    });
    return state;
  }

  it('holds the optimistic flip, clears it once a poll confirms it, then follows a later server change (T1)', async () => {
    vi.useFakeTimers();
    const state = modelServer(true);
    render(<Schedules env="prod" />);
    await flush();
    expect(isOn()).toBe(true);

    fireEvent.click(screen.getByRole('switch')); // optimistic disable
    await flush();
    expect(isOn()).toBe(false); // override held — no confirming poll yet

    await poll(); // GET now reflects enabled=false → the override is confirmed & dropped
    expect(isOn()).toBe(false);
    state.enabled = true; // another operator re-enables server-side
    await poll();
    expect(isOn()).toBe(true); // override gone, so the server change shows through
  });

  it('keeps the override while a poll still disagrees (clear only on agreement, T1)', async () => {
    vi.useFakeTimers();
    modelServer(true);
    render(<Schedules env="prod" />);
    await flush();
    // Force every subsequent GET to report the pre-write value (server lagging).
    fetchMock.mockImplementation((_i: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? Promise.resolve(json({ ok: true }, 200))
        : Promise.resolve(json({ schedules: [{ ...schedule, enabled: true }] }, 200)));
    fireEvent.click(screen.getByRole('switch')); // optimistic disable
    await flush();
    await poll(); // poll=true diverges from override=false → held, not cleared
    expect(isOn()).toBe(false);
  });

  it('blocks duplicate clicks while pending and permits a successful retry after rollback (T2)', async () => {
    vi.useFakeTimers();
    let patch = 0;
    const state = { enabled: true };
    fetchMock.mockImplementation((_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patch++;
        if (patch === 1) return Promise.resolve(json({ error: { code: 'internal_error', message: 'boom' } }, 500));
        state.enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
        return Promise.resolve(json({ ok: true }, 200));
      }
      return Promise.resolve(json({ schedules: [{ ...schedule, enabled: state.enabled }] }, 200));
    });
    render(<Schedules env="prod" />);
    await flush();
    const btn = screen.getByRole('switch');
    fireEvent.click(btn); // disable — its PATCH will fail
    fireEvent.click(btn); // the in-flight row cannot issue a second PATCH
    expect(patch).toBe(1);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    await flush();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(isOn()).toBe(true);
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await flush();
    expect(patch).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(isOn()).toBe(false);
    await poll();
    expect(isOn()).toBe(false); // final UI follows the successful retry
  });

  it('exposes an accessible name on the toggle switch (T3)', async () => {
    modelServer(true);
    render(<Schedules env="prod" />);
    await waitFor(() => expect(screen.getByText('0 0 * * *')).toBeTruthy());
    const sw = screen.getByRole('switch', { name: 'Toggle t schedule' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('only disables the pending row and announces its saved paused state', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Promise<Response>((resolve) => { finish = resolve; });
      return Promise.resolve(json({ schedules: [schedule, { ...schedule, id: 's2', taskId: 'other-task' }] }, 200));
    });
    render(<Schedules />);
    const first = await screen.findByRole('switch', { name: 'Toggle t schedule' });
    const second = screen.getByRole('switch', { name: 'Toggle other-task schedule' });
    fireEvent.click(first);
    expect((first as HTMLButtonElement).disabled).toBe(true);
    expect((second as HTMLButtonElement).disabled).toBe(false);
    expect(first.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Saving…')).toBeTruthy();
    fireEvent.click(first);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PATCH')).toHaveLength(1);
    await act(async () => finish(json({ ok: true }, 200)));
    expect((first as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.queryByText('Saving…')).toBeNull();
  });

  it('discards a late write failure after changing environment', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Promise<Response>((resolve) => { finish = resolve; });
      return Promise.resolve(json({ schedules: [schedule] }, 200));
    });
    const { rerender } = render(<Schedules env="prod" />);
    fireEvent.click(await screen.findByRole('switch'));
    expect(screen.getByText('Saving…')).toBeTruthy();
    rerender(<Schedules env="dev" />);
    const current = await screen.findByRole('switch');
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect((current as HTMLButtonElement).disabled).toBe(false);
    await act(async () => finish(json({ error: { code: 'unauthorized', message: 'old environment failure' } }, 401)));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(recordConnectionError).not.toHaveBeenCalled();
    expect(current.getAttribute('aria-checked')).toBe('true');
  });

  it('drops pending state for a removed row and ignores its late failure after it reappears', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    let rows = [schedule];
    fetchMock.mockImplementation((_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Promise<Response>((resolve) => { finish = resolve; });
      return Promise.resolve(json({ schedules: rows }, 200));
    });
    render(<Schedules />);
    await flush();
    fireEvent.click(screen.getByRole('switch'));
    rows = [];
    await poll();
    expect(screen.getByText('No schedules yet')).toBeTruthy();
    rows = [schedule];
    await poll();
    const current = screen.getByRole('switch');
    expect((current as HTMLButtonElement).disabled).toBe(false);
    await act(async () => finish(json({ error: { code: 'internal_error', message: 'stale failure' } }, 500)));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(current.getAttribute('aria-checked')).toBe('true');
  });
});
