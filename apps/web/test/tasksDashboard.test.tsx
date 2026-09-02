/* =============================================================================
   Better Trigger — Tasks dashboard secondary polling errors (T6).

   The dashboard consumed only useTasks' error: a failed /workers or
   /schedules poll left the stat cards silently showing "—", hiding that a
   whole endpoint was down. The dependent cards now surface that.
   ============================================================================= */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksDashboard } from '../src/screens/TasksDashboard';
import { setApiKey } from '../src/api/client';
import { resetConnection } from '../src/api/hooks';
import type { TaskSummary } from '../src/api/client';

const task: TaskSummary = {
  id: 't', name: 't', filePath: 'tasks.ts', triggerSource: 'api', cronPattern: null,
  runs24h: 3, p50Ms: 10, p95Ms: 20, successRate: 100, trend: [], lastRunAt: null,
};

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const boom = (): Response =>
  new Response(JSON.stringify({ error: { code: 'internal_error', message: 'boom' } }), { status: 500 });

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

describe('TasksDashboard secondary errors', () => {
  it('flags the workers and schedules cards when those endpoints fail', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/tasks')) return Promise.resolve(ok({ tasks: [task] }));
      return Promise.resolve(boom());
    });
    render(<TasksDashboard setRoute={() => {}} env="prod" />);

    await waitFor(() => expect(screen.getByText('schedules unavailable')).toBeTruthy());
    expect(screen.getByText('unavailable')).toBeTruthy();
  });

  it('shows no unavailable indicator when every endpoint is healthy', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/tasks')) return Promise.resolve(ok({ tasks: [task] }));
      if (u.includes('/workers')) return Promise.resolve(ok({ workers: [] }));
      if (u.includes('/schedules')) return Promise.resolve(ok({ schedules: [] }));
      return Promise.resolve(ok({ runs: [], nextCursor: null }));
    });
    render(<TasksDashboard setRoute={() => {}} env="prod" />);

    await waitFor(() => expect(screen.getByText('Active tasks')).toBeTruthy());
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });
});
