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
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
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
  const row = screen.getByText('0 0 * * *').parentElement as HTMLElement;
  // The schedule Switch is a real button[role=switch] (p2-19) — query it by
  // role instead of the div+inline-cursor shape it used to have.
  const track = row.querySelector<HTMLElement>('button[role="switch"]') as HTMLElement;
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
    // …and the optimistic flip reverted: the row is back to enabled
    // (opacity 1, accent-colored switch track).
    expect(row.style.opacity).toBe('1');
    expect(row.querySelector('[style*="background: var(--accent)"]')).toBeTruthy();
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

  it('a failed first toggle superseded by a successful second stays in sync with the server and raises no error (T2)', async () => {
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
    fireEvent.click(btn); // enable — issued same tick, supersedes the first
    await flush();
    expect(screen.queryByRole('alert')).toBeNull(); // superseded failure ignored
    expect(isOn()).toBe(true);
    await poll();
    expect(isOn()).toBe(true); // final UI matches the server (enabled)
  });

  it('exposes an accessible name on the toggle switch (T3)', async () => {
    modelServer(true);
    render(<Schedules env="prod" />);
    await waitFor(() => expect(screen.getByText('0 0 * * *')).toBeTruthy());
    const sw = screen.getByRole('switch', { name: 'Toggle t schedule' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });
});
