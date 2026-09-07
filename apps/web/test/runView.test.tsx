/* =============================================================================
   Better Trigger — RunView span-row accessibility (T4).

   The waterfall rows were bare <div onClick> — mouse-only, so keyboard users
   could never reach the Inspector for a child step. They now follow the Card
   pattern (role=button + tabIndex + Enter/Space) and announce their selected
   state via aria-pressed.
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/features/run/RunView';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';
import type { RunDetailResponse } from '../src/api/client';

const NOW = Date.parse('2026-08-11T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const detail: RunDetailResponse = {
  run: {
    id: 'r1', taskId: 'parent-task', status: 'completed', trigger: 'api', codeVersion: 'v',
    projectId: 'default', env: 'prod', attempt: 1, maxAttempts: 1, durationMs: 5000,
    createdAt: iso(NOW - 5000), startedAt: iso(NOW - 5000), finishedAt: iso(NOW),
    payload: null, output: null, error: null, parentRunId: null, idempotencyKey: null, queuedAt: iso(NOW - 5000),
  },
  steps: [
    { seq: 0, kind: 'step', label: 'child-op', status: 'completed', output: null, error: null, attempt: 1, startedAt: iso(NOW - 4000), finishedAt: iso(NOW - 1000) },
  ],
  stepsTruncated: false,
  waits: [],
  waitsTruncated: false,
  logs: [],
  logsNextCursor: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setApiKey(null);
  resetConnection();
  fetchMock = vi.fn();
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(detail), { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SpanRow keyboard access (T4)', () => {
  it('renders rows as focusable buttons that select the span on Enter/Space', async () => {
    render(<RunView runId="r1" />);
    await waitFor(() => expect(screen.getByText('child-op')).toBeTruthy());

    const row = screen.getByRole('button', { name: /child-op/ });
    expect(row.getAttribute('role')).toBe('button');
    expect((row as HTMLElement).tabIndex).toBe(0);
    // The root span is the default selection, so the child starts unselected.
    expect(row.getAttribute('aria-pressed')).toBe('false');

    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(row.getAttribute('aria-pressed')).toBe('true'));

    // Space activates too, and selecting the root clears the child.
    const root = screen.getByRole('button', { name: /parent-task/ });
    fireEvent.keyDown(root, { key: ' ' });
    await waitFor(() => expect(row.getAttribute('aria-pressed')).toBe('false'));
    expect(root.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the selected span and poller when switching the compact view tabs', async () => {
    render(<RunView runId="r1" />);
    const row = await screen.findByRole('button', { name: /child-op/ });
    fireEvent.click(row);
    const fetches = fetchMock.mock.calls.length;
    const [traceTab, detailsTab] = screen.getAllByRole('tab', { hidden: true });
    fireEvent.click(detailsTab);
    expect(detailsTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Span details' }).textContent).toContain('child-op');
    fireEvent.keyDown(detailsTab, { key: 'ArrowLeft' });
    expect(traceTab.getAttribute('aria-selected')).toBe('true');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(fetchMock.mock.calls.length).toBe(fetches);
  });
});

describe('Inspector content and copy feedback', () => {
  const payload = { request: 'a'.repeat(600), nested: { customer: 'example' } };
  const runError = { name: 'Error', message: 'Request timed out', stack: 'Error: Request timed out\n    at processTask (/worker/task.ts:12)' };
  const failedDetail: RunDetailResponse = {
    ...detail,
    run: { ...detail.run, status: 'failed', payload, error: runError, output: { processed: false } },
    steps: [{ ...detail.steps[0], output: { child: 'result' } }],
  };

  beforeEach(() => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(failedDetail), { status: 200 })));
  });

  it('puts the error before a collapsed large payload and copies the complete hidden content', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<RunView runId="r1" />);
    const inspector = await screen.findByRole('tabpanel', { name: 'Span details' });
    const error = within(inspector).getByRole('region', { name: 'Error' });
    const payloadSection = within(inspector).getByRole('region', { name: 'Payload' });
    expect(error.compareDocumentPosition(payloadSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(error).getByText('Request timed out')).toBeTruthy();
    expect(payloadSection.querySelector('details')!.open).toBe(false);

    fireEvent.click(within(payloadSection).getByRole('button', { name: 'Copy Payload' }));
    await waitFor(() => expect(within(payloadSection).getByRole('status').textContent).toBe('Copied'));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(payload, null, 2));
    fireEvent.click(within(error).getByRole('button', { name: 'Copy Error' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${runError.message}\n\n${runError.stack}`));
  });

  it('reports denied clipboard access and clears feedback when another span is selected', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<RunView runId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Output' }));
    await waitFor(() => expect(screen.getByText('Copy failed')).toBeTruthy());
    expect(screen.queryByText('Copied')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /child-op/ }));
    expect(screen.queryByText('Copy failed')).toBeNull();
    writeText.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Output' }));
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify({ child: 'result' }, null, 2));
  });

  it('does not report an earlier pending copy on the newly selected span', async () => {
    let resolveCopy!: () => void;
    vi.stubGlobal('navigator', { clipboard: { writeText: () => new Promise<void>((resolve) => { resolveCopy = resolve; }) } });
    render(<RunView runId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Output' }));
    fireEvent.click(screen.getByRole('button', { name: /child-op/ }));
    resolveCopy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy Output' }).textContent).toBe('Copy'));
    expect(screen.queryByText('Copied')).toBeNull();
  });
});
