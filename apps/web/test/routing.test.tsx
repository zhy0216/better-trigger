/* =============================================================================
   Better Trigger — URL routing (P1-18): the daemon's SPA fallback
   (apps/worker/src/static.ts) serves index.html for deep links, so App must
   seed route/runId from location.pathname and keep the address bar in sync
   when navigating (pushState) and on back/forward (popstate). jsdom history is
   fully traversable, so these run without a router library.

   Rendered with @testing-library/react under jsdom against a stubbed fetch;
   the root div's data-screen-label distinguishes the current screen.
   ============================================================================= */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';
import type { RunDetailResponse, RunsResponse, RunSummary } from '../src/api/client';

const NOW = Date.parse('2026-08-11T12:00:00Z');

const run = (id: string): RunSummary => ({
  id,
  taskId: 't',
  status: 'completed',
  trigger: 'api',
  codeVersion: 'v',
  env: 'prod',
  attempt: 1,
  durationMs: 1000,
  createdAt: new Date(NOW - 60_000).toISOString(),
  startedAt: new Date(NOW - 60_000).toISOString(),
  finishedAt: new Date(NOW - 59_000).toISOString(),
});

function runsPage(ids: string[]): RunsResponse {
  return { runs: ids.map(run), nextCursor: null };
}

function detail(id: string): RunDetailResponse {
  return {
    run: {
      id,
      taskId: 't',
      status: 'completed',
      trigger: 'api',
      codeVersion: 'v',
      projectId: 'default',
      env: 'prod',
      attempt: 1,
      maxAttempts: 1,
      durationMs: 1000,
      createdAt: new Date(NOW - 60_000).toISOString(),
      startedAt: new Date(NOW - 60_000).toISOString(),
      finishedAt: new Date(NOW - 59_000).toISOString(),
      payload: null,
      output: null,
      error: null,
      parentRunId: null,
      idempotencyKey: null,
      queuedAt: new Date(NOW - 60_000).toISOString(),
    },
    steps: [],
    stepsTruncated: false,
    waits: [],
    waitsTruncated: false,
    logs: [],
    logsNextCursor: null,
  };
}

/** The root div's data-screen-label (App renders it from the active route). */
const screenLabel = () =>
  document.querySelector('[data-screen-label]')?.getAttribute('data-screen-label') ?? null;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setApiKey(null);
  resetConnection();
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes('/runs/')) {
      const id = /\/runs\/([^/]+)\?/.exec(u)?.[1] ?? 'r1';
      return Promise.resolve(new Response(JSON.stringify(detail(id)), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(runsPage(['r1', 'r2'])), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('App URL routing', () => {
  it('deep link /runs/<id> renders the RunView for that run, not the list', async () => {
    window.history.pushState(null, '', '/runs/run_xyz');
    render(<App />);

    // The run detail requests that exact id and shows it in the header.
    await waitFor(() => expect(screen.getByText('run_xyz')).toBeTruthy());
    expect(screenLabel()).toBe('Run');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/runs/run_xyz'))).toBe(true);
    // The runs list is not mounted.
    expect(screen.queryByPlaceholderText('Filter by task or run id')).toBeNull();
    expect(window.location.pathname).toBe('/runs/run_xyz');
  });

  it('clicking a run pushes /runs/<id>; back returns to the runs list', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText('r1')).toBeTruthy());
    expect(screenLabel()).toBe('Runs');

    fireEvent.click(screen.getByText('r1'));
    await waitFor(() => expect(window.location.pathname).toBe('/runs/r1'));
    expect(screenLabel()).toBe('Run');

    window.history.back();
    await waitFor(() => expect(screenLabel()).toBe('Runs'));
    expect(window.location.pathname).toBe('/runs');
    await waitFor(() => expect(screen.getByPlaceholderText('Filter by task or run id')).toBeTruthy());
  });

  it('round-trips a deep link through back/forward without losing the run', async () => {
    window.history.pushState(null, '', '/runs/a');
    render(<App />);

    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
    expect(screenLabel()).toBe('Run');

    window.history.back();
    await waitFor(() => expect(screenLabel()).toBe('Runs'));
    expect(window.location.pathname).toBe('/');

    window.history.forward();
    await waitFor(() => expect(screenLabel()).toBe('Run'));
    expect(window.location.pathname).toBe('/runs/a');
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
  });

  it('unknown paths fall back to the runs list and are canonicalized', async () => {
    window.history.pushState(null, '', '/workers');
    render(<App />);

    await waitFor(() => expect(screenLabel()).toBe('Runs'));
    await waitFor(() => expect(screen.getByPlaceholderText('Filter by task or run id')).toBeTruthy());
    // The mount seed replaces the URL with the canonical /runs path.
    expect(window.location.pathname).toBe('/runs');
  });
});
