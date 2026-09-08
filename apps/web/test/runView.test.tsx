/* =============================================================================
   Better Trigger — RunView span-row accessibility (T4).

   The waterfall rows were bare <div onClick> — mouse-only, so keyboard users
   could never reach the Inspector for a child step. They now follow the Card
   pattern (role=button + tabIndex + Enter/Space) and announce their selected
   state via aria-pressed.
   ============================================================================= */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/features/run/RunView';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';
import * as hooks from '../src/api/hooks';
import { adaptRunDetail } from '../src/api/adapter';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferredCopy() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

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

  it('preserves a copy started after DOM commit but before passive effects', async () => {
    const pending = deferredCopy();
    const writeText = vi.fn(() => pending.promise);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    // Supply an accepted detail synchronously so a parent layout effect can
    // activate its committed button before CopyButton's passive value effect.
    // This controls the ordering; it does not assume how the historical PG
    // root-test failure was scheduled.
    vi.spyOn(hooks, 'useRun').mockReturnValue({
      data: adaptRunDetail(failedDetail), loading: false, error: null,
      loadOlderLogs: async () => false, loadingOlderLogs: false, hasOlderLogs: false, loadOlderLogsError: null,
    });
    function CopyOnCommit() {
      React.useLayoutEffect(() => {
        screen.getByRole('button', { name: 'Copy Payload' }).click();
      }, []);
      return <RunView runId="r1" />;
    }
    render(<CopyOnCommit />);
    const payloadSection = screen.getByRole('region', { name: 'Payload' });
    expect(payloadSection.querySelector('details')!.open).toBe(false);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(payload, null, 2));
    await act(async () => { pending.resolve(); });
    expect(within(payloadSection).getByRole('status').textContent).toBe('Copied');
    expect(payloadSection.isConnected).toBe(true);
  });

  for (const target of ['span', 'run'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      it(`ignores old copy ${outcome} after switching ${target} while the new copy is pending`, async () => {
        const old = deferredCopy();
        const current = deferredCopy();
        const writeText = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          const id = new URL(String(input)).pathname.split('/').pop()!;
          return Promise.resolve(new Response(JSON.stringify({ ...failedDetail, run: { ...failedDetail.run, id } })));
        });
        const view = render(<RunView runId="r1" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Copy Output' }));
        const oldSection = screen.getByRole('region', { name: 'Output' });
        if (target === 'span') fireEvent.click(screen.getByRole('button', { name: /child-op/ }));
        else view.rerender(<RunView runId="r2" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Copy Output' }));
        expect(oldSection.isConnected).toBe(false);
        const currentSection = screen.getByRole('region', { name: 'Output' });
        await act(async () => {
          if (outcome === 'success') old.resolve();
          else old.reject(new Error('old permission denial'));
        });
        const button = within(currentSection).getByRole('button', { name: 'Copy Output' }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.textContent).toBe('Copying…');
        expect(within(currentSection).getByRole('status').textContent).toBe('');
        await act(async () => { current.resolve(); });
        expect(within(currentSection).getByRole('status').textContent).toBe('Copied');
        expect(writeText).toHaveBeenLastCalledWith(JSON.stringify(target === 'span' ? { child: 'result' } : { processed: false }, null, 2));
      });
    }
  }

  it('retains the copy through same-value frames and invalidates it when the value changes', async () => {
    const old = deferredCopy();
    const current = deferredCopy();
    const writeText = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const frame = (response: RunDetailResponse) => ({
      data: adaptRunDetail(response), loading: false, error: null,
      loadOlderLogs: async () => false, loadingOlderLogs: false, hasOlderLogs: false, loadOlderLogsError: null,
    });
    const query = vi.spyOn(hooks, 'useRun').mockReturnValue(frame(failedDetail));
    const view = render(<RunView runId="r1" />);
    const section = screen.getByRole('region', { name: 'Output' });
    fireEvent.click(within(section).getByRole('button', { name: 'Copy Output' }));
    query.mockReturnValue(frame(failedDetail));
    view.rerender(<RunView runId="r1" />);
    expect(screen.getByRole('region', { name: 'Output' })).toBe(section);
    expect((within(section).getByRole('button', { name: 'Copy Output' }) as HTMLButtonElement).disabled).toBe(true);
    query.mockReturnValue(frame({ ...failedDetail, run: { ...failedDetail.run, output: { processed: true } } }));
    view.rerender(<RunView runId="r1" />);
    fireEvent.click(within(section).getByRole('button', { name: 'Copy Output' }));
    await act(async () => { old.reject(new Error('old denial')); });
    expect(within(section).getByRole('status').textContent).toBe('');
    expect((within(section).getByRole('button', { name: 'Copy Output' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { current.resolve(); });
    expect(within(section).getByRole('status').textContent).toBe('Copied');
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify({ processed: true }, null, 2));
  });
});
