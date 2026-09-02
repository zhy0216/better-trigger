/* =============================================================================
   Better Trigger — Schedules toggle failures (P1-17 C2).

   A failed enable/disable used to roll back the optimistic switch in silence;
   now it surfaces an inline alert (RunView's actionError pattern) and feeds a
   401 into the shared connection registry so the key prompt can take over.
   recordConnectionError is spied through a partial mock: the registry's own
   outcome semantics are already covered by hooks/runActions tests — what is
   pinned here is that the toggle wires itself into that channel, and only for
   auth rejections.
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  const track = row.querySelector<HTMLElement>('div[style*="cursor: pointer"]') as HTMLElement;
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
    expect(row.querySelector('div[style*="background: var(--accent)"]')).toBeTruthy();
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
