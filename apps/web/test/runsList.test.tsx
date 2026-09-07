/* =============================================================================
   Better Trigger — Runs list search + status chips (p2-33).

   The search box filters server-side by taskId: useRuns must send the query as
   the `taskId` param (so a run not on the first loaded page can be found —
   the old client-side filter only ever saw the 50 loaded rows), and the
   status chips must cover the full server status vocabulary including the
   waiting/canceled pair the adapter already maps.
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  vi.useRealTimers();
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

describe('RunsList toolbar a11y', () => {
  it('gives the task filter an accessible name', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(runsPage(['a1']))));
    render(<RunsList env="prod" onOpenRun={() => {}} />);

    expect(screen.getByRole('textbox', { name: 'Filter by task ID' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());
  });

  it('exposes aria-pressed on the status filter group and the live toggle (T8)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(runsPage(['a1'], 'task-a'))));
    render(<RunsList env="prod" onOpenRun={() => {}} />);
    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());

    const group = screen.getByRole('group', { name: 'Status filter' });
    const all = within(group).getByRole('button', { name: 'All' });
    const running = within(group).getByRole('button', { name: 'Running' });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(running.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(running);
    expect(running.getAttribute('aria-pressed')).toBe('true');
    expect(all.getAttribute('aria-pressed')).toBe('false');

    const live = screen.getByRole('button', { name: /Live tailing/ });
    expect(live.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(live);
    expect(screen.getByRole('button', { name: /Paused/ }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('RunsList empty states', () => {
  it('explains an environment with no runs without suggesting active filters', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(runsPage([]))));
    render(<RunsList env="prod" onOpenRun={() => {}} />);

    await waitFor(() => expect(screen.getByText('No runs yet.')).toBeTruthy());
    expect(screen.getByText('0 runs loaded')).toBeTruthy();
    expect(screen.queryByText('No runs match these filters.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('clears status and task ID together while retaining the environment and live mode', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      return Promise.resolve(res(url.searchParams.has('status') || url.searchParams.has('taskId')
        ? runsPage([])
        : runsPage(['a1'])));
    });
    render(<RunsList env="staging" onOpenRun={() => {}} />);
    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());

    fireEvent.click(within(screen.getByRole('group', { name: 'Status filter' })).getByRole('button', { name: 'Failed' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by task ID' }), { target: { value: 'missing-task' } });
    await waitFor(() => expect(screen.getByText('No runs match these filters.')).toBeTruthy());
    const filteredUrl = new URL(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]), 'http://localhost');
    expect(filteredUrl.searchParams.get('taskId')).toBe('missing-task');
    expect(filteredUrl.searchParams.get('status')).toBe('failed');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByText('a1')).toBeTruthy());

    const url = new URL(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]), 'http://localhost');
    expect(url.searchParams.has('taskId')).toBe(false);
    expect(url.searchParams.has('status')).toBe(false);
    expect(url.searchParams.get('env')).toBe('staging');
    expect((screen.getByRole('textbox', { name: 'Filter by task ID' }) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Live tailing' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps a cleared query paused until the user resumes', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(runsPage([]))));
    render(<RunsList env="staging" onOpenRun={() => {}} />);
    await waitFor(() => expect(screen.getByText('No runs yet.')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Waiting' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by task ID' }), { target: { value: 'task-z' } });
    await waitFor(() => expect(screen.getByText('No runs match these filters.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Live tailing' }));
    const requestsWhilePaused = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('button', { name: 'Paused' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('Updates are paused.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(requestsWhilePaused);

    fireEvent.click(screen.getByRole('button', { name: 'Resume live updates' }));
    await waitFor(() => expect(screen.getByText('No runs yet.')).toBeTruthy());
    const url = new URL(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]), 'http://localhost');
    expect(url.searchParams.has('taskId')).toBe(false);
    expect(url.searchParams.has('status')).toBe(false);
    expect(url.searchParams.get('env')).toBe('staging');
  });
});

describe('RunsList loaded history', () => {
  it('preserves loaded rows after a pagination failure and retries the same cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(res(runsPage(['a1', 'a0'], 'task-a', 'older-runs')))
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(res(runsPage(['b1'], 'task-b')));
    render(<RunsList env="prod" onOpenRun={() => {}} />);
    await waitFor(() => expect(screen.getByText('2 runs loaded')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('a1')).toBeTruthy();
    expect(screen.getByText('2 runs loaded')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry loading more' }));
    await waitFor(() => expect(screen.getByText('3 runs loaded')).toBeTruthy());
    expect(screen.getByText('b1')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const cursorRequests = fetchMock.mock.calls.slice(1).map(([input]) => new URL(String(input), 'http://localhost').searchParams.get('cursor'));
    expect(cursorRequests).toEqual(['older-runs', 'older-runs']);
  });

  it('holds loaded rows and stops polling while paused, then refreshes immediately on resume', async () => {
    fetchMock.mockResolvedValue(res(runsPage(['a1'], 'task-a', 'older-runs')));
    render(<RunsList env="prod" onOpenRun={() => {}} />);
    await waitFor(() => expect(screen.getByText('1 run loaded')).toBeTruthy());
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: 'Live tailing' }));
    const requestsWhilePaused = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchMock).toHaveBeenCalledTimes(requestsWhilePaused);
    expect(screen.getByText('a1')).toBeTruthy();
    expect(screen.getByText('Updates paused')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Load more' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Paused' }));
    expect(fetchMock).toHaveBeenCalledTimes(requestsWhilePaused + 1);
    expect(screen.getByRole('button', { name: 'Live tailing' })).toBeTruthy();
  });

  it('preserves full identifiers in one native button per run', async () => {
    const taskId = `task-${'very-long-task-name-'.repeat(8)}`;
    const runId = `run-${'1234567890'.repeat(12)}`;
    const onOpenRun = vi.fn();
    fetchMock.mockResolvedValue(res(runsPage([runId], taskId)));
    render(<RunsList env="prod" onOpenRun={onOpenRun} />);

    const row = await screen.findByRole('button', { name: new RegExp(runId) });
    expect(row.tagName).toBe('BUTTON');
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTitle(runId)).toBeTruthy();
    expect(screen.getByTitle(taskId)).toBeTruthy();
    fireEvent.click(row);
    expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ id: runId, task: taskId }));
  });
});
