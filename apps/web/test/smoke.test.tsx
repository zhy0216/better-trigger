/* =============================================================================
   Better Trigger — dashboard browser-level smoke tests (O5).

   The five states that used to be verified by hand against a live daemon,
   rendered as the real component tree (jsdom + @testing-library/react, the
   same stack as the existing apiAuth tests, with a DOM added):

     1. server down      → the TopBar connection dot reads "Offline"
     2. 401              → the ApiKeyPrompt ("需要 API key") replaces the UI
     3. empty data       → the runs list renders its empty state
     4. long logs        → run detail renders a full 200-line log page
     5. pagination       → "Load more" appends the next cursor page, then ends

   This is not a full browser (no real layout/network), but it renders the
   actual components with real effects, polling and event handlers against a
   stubbed fetch — the interactions the acceptance criteria name, guarded
   from regression on every `bun run test`.
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';
import { RunView } from '../src/features/run/RunView';
import { RunsList } from '../src/screens/RunsList';
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

function runsPage(ids: string[], nextCursor: string | null): RunsResponse {
  return { runs: ids.map(run), nextCursor };
}

/** A run detail whose log stream starts at id `startId`; logsBefore=nullCursor
 *  marks the earliest page (no older logs). */
function detailWithLogs(startId: number, count: number, logsBefore: number | null): RunDetailResponse {
  return {
    run: {
      id: 'r1',
      taskId: 't',
      status: 'completed',
      trigger: 'api',
      codeVersion: 'v',
      projectId: 'default',
      env: 'prod',
      attempt: 1,
      maxAttempts: 3,
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
    steps: [
      {
        seq: 0,
        kind: 'step',
        label: 'load',
        status: 'completed',
        output: null,
        error: null,
        attempt: 1,
        startedAt: new Date(NOW - 60_000).toISOString(),
        finishedAt: new Date(NOW - 59_000).toISOString(),
      },
    ],
    stepsTruncated: false,
    waits: [],
    waitsTruncated: false,
    logs: Array.from({ length: count }, (_, i) => ({
      id: startId + i,
      stepSeq: null,
      level: 'info',
      message: `long log line ${startId + i}`,
      data: null,
      ts: new Date(NOW - 60_000 + startId + i).toISOString(),
    })),
    // logsBefore == nullCursor ⇒ this page is the earliest: no older logs.
    logsNextCursor: logsBefore,
  };
}

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

describe('dashboard smoke — the states that used to need a live daemon', () => {
  it('1. server down: the connection dot reads Offline and the list errors out', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<App />);

    await waitFor(() => expect(screen.getByTitle(/server unreachable/i)).toBeTruthy());
    expect(screen.getByText('Offline')).toBeTruthy();
    // The runs list shows the fetch error, not an eternal spinner.
    await waitFor(() => expect(screen.getByText(/failed to fetch/i)).toBeTruthy());
  });

  it('2. 401: the API-key prompt replaces the UI and stays distinguishable', async () => {
    fetchMock.mockImplementation(() => 
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'invalid key' } }), { status: 401 }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByText('Enter your API key')).toBeTruthy());
    expect(screen.getByPlaceholderText('Bearer token')).toBeTruthy();
    expect(screen.getByText('API key required')).toBeTruthy(); // connection dot
    // First visit (nothing submitted yet): no "key was rejected" variant.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('2b. a REJECTED key re-shows the prompt with the token kept and a rejection message', async () => {
    fetchMock.mockImplementation(() => 
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'invalid key' } }), { status: 401 }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByText('Enter your API key')).toBeTruthy());
    const input = screen.getByPlaceholderText('Bearer token');
    fireEvent.change(input, { target: { value: 'wrong-token' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    // The daemon keeps rejecting: the prompt returns as a rejection variant,
    // with the typed token still in the field (not a blank first-visit prompt).
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/That key was rejected/i)).toBeTruthy();
    expect((screen.getByPlaceholderText('Bearer token') as HTMLInputElement).value).toBe('wrong-token');
  });

  it('3. empty data: the runs list renders its empty state', async () => {
    fetchMock.mockImplementation(() => 
      new Response(JSON.stringify(runsPage([], null)), { status: 200 }),
    );
    render(<RunsList env="prod" onOpenRun={() => {}} />);

    await waitFor(() => expect(screen.getByText('No runs match these filters.')).toBeTruthy());
  });

  it('4. long logs: Load older logs walks the logsNextCursor chain, deduped, until exhausted', async () => {
    // Newest page: ids 201..400. Older page: ids 1..250 (overlapping ids
    // 201..250 with the head — the head slid forward between polls). The
    // union is 400 unique lines; the older page is the earliest (null cursor).
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('logsBefore=')) {
        return Promise.resolve(
          new Response(JSON.stringify(detailWithLogs(1, 250, null)), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(detailWithLogs(201, 200, 201)), { status: 200 }),
      );
    });
    render(<RunView runId="r1" />);

    // Newest page renders with the Load older logs affordance.
    await waitFor(() => expect(screen.getByText('200 lines')).toBeTruthy());
    expect(screen.getByText('long log line 400')).toBeTruthy();
    expect(screen.getByText('Load older logs')).toBeTruthy();

    fireEvent.click(screen.getByText('Load older logs'));

    // The older page appended: 400 unique lines, the overlap deduped.
    await waitFor(() => expect(screen.getByText('400 lines')).toBeTruthy());
    expect(screen.getByText('long log line 1')).toBeTruthy();
    expect(screen.getAllByText('long log line 250')).toHaveLength(1);
    // The exhausted cursor removed the button.
    await waitFor(() => expect(screen.queryByText('Load older logs')).toBeNull());
  });

  it('5. pagination: Load more appends the next cursor page, then ends', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(runsPage(['a1', 'a0'], 'c1')), { status: 200 }))
      .mockImplementation(() => new Response(JSON.stringify(runsPage(['b1', 'b0'], null)), { status: 200 }));
    render(<RunsList env="prod" onOpenRun={() => {}} />);

    // Page 1 renders with a Load more affordance.
    await waitFor(() => expect(screen.getByText('Load more')).toBeTruthy());
    expect(screen.getByText('a1')).toBeTruthy();

    fireEvent.click(screen.getByText('Load more'));

    // The older page appended; the exhausted cursor removed the button.
    await waitFor(() => expect(screen.getByText('b1')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('Load more')).toBeNull());
    expect(screen.getAllByText(/^[ab]\d$/).length).toBe(4);
  });
});
