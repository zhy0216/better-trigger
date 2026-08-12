/* =============================================================================
   Better Trigger — Runs list search + status chips (p2-33).

   The search box filters server-side by taskId: useRuns must send the query as
   the `taskId` param (so a run not on the first loaded page can be found —
   the old client-side filter only ever saw the 50 loaded rows), and the
   status chips must cover the full server status vocabulary including the
   waiting/canceled pair the adapter already maps.
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunsList } from '../src/screens/RunsList';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';
import type { RunsResponse, RunSummary } from '../src/api/client';

const NOW = Date.parse('2026-08-11T12:00:00Z');

const run = (id: string, taskId: string): RunSummary => ({
  id,
  taskId,
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

function runsPage(ids: string[], taskId = 'task-a', nextCursor: string | null = null): RunsResponse {
  return { runs: ids.map((id) => run(id, taskId)), nextCursor };
}

const res = (body: RunsResponse): Response =>
  new Response(JSON.stringify(body), { status: 200 });

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

describe('RunsList server-side search', () => {
  it('sends the query as taskId and shows a matching run that was not on the first page', async () => {
    // The first loaded page only carries task-a runs; a task-z run exists only
    // when the server gets a taskId filter.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('taskId=task-z')) return Promise.resolve(res(runsPage(['z1'], 'task-z')));
      return Promise.resolve(res(runsPage(['a1', 'a0'], 'task-a')));
    });
    render(<RunsList env="prod" onOpenRun={() => {}} />);

    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());
    expect(screen.queryByText('z1')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('Filter by task id…'), { target: { value: 'task-z' } });

    // The request carried the taskId and the previously-unreachable run appears.
    await waitFor(() => expect(screen.getByText('z1')).toBeTruthy());
    expect(fetchMock.mock.calls.some(([inp]) => String(inp).includes('taskId=task-z'))).toBe(true);
    expect(screen.queryByText('a1')).toBeNull();
  });

  it('does not send taskId when the box is empty', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(runsPage(['a1'], 'task-a'))));
    render(<RunsList env="prod" onOpenRun={() => {}} />);

    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());
    const urls = fetchMock.mock.calls.map(([inp]) => String(inp));
    expect(urls.every((u) => !u.includes('taskId='))).toBe(true);
  });
});

describe('RunsList status chips', () => {
  it('renders the full status vocabulary including waiting and canceled', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(runsPage(['a1'], 'task-a'))));
    render(<RunsList env="prod" onOpenRun={() => {}} />);

    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());
    // The chips are the toolbar buttons (a row's StatusBadge may repeat a
    // label like "Completed", so scope the assertion to the buttons).
    const chipLabels = screen.getAllByRole('button').map((b) => b.textContent?.trim() ?? '');
    for (const label of ['All', 'Running', 'Completed', 'Failed', 'Queued', 'Waiting', 'Canceled']) {
      expect(chipLabels).toContain(label);
    }
  });

  it('maps the waiting chip to the server waiting status', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(runsPage(['a1'], 'task-a'))));
    render(<RunsList env="prod" onOpenRun={() => {}} />);

    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());
    fireEvent.click(screen.getByText('Waiting'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([inp]) => String(inp).includes('status=waiting'))).toBe(true),
    );
  });

  it('maps the canceled chip to the server canceled status', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(runsPage(['a1'], 'task-a'))));
    render(<RunsList env="prod" onOpenRun={() => {}} />);

    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());
    fireEvent.click(screen.getByText('Canceled'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([inp]) => String(inp).includes('status=canceled'))).toBe(true),
    );
  });
});
