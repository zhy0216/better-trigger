/* =============================================================================
   Better Trigger — RunView span-row accessibility (T4).

   The waterfall rows were bare <div onClick> — mouse-only, so keyboard users
   could never reach the Inspector for a child step. They now follow the Card
   pattern (role=button + tabIndex + Enter/Space) and announce their selected
   state via aria-pressed.
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
