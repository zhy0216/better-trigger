/* =============================================================================
   Better Trigger — Tasks dashboard secondary polling errors (T6).

   The dashboard consumed only useTasks' error: a failed /workers or
   /schedules poll left the stat cards silently showing "—", hiding that a
   whole endpoint was down. The dependent cards now surface that.
   ============================================================================= */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

    await waitFor(() => expect(screen.getByRole('group', { name: 'Registered tasks' })).toBeTruthy());
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });

  it('distinguishes loading workers from a confirmed zero online count', async () => {
    let resolveWorkers!: (response: Response) => void;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/tasks')) return Promise.resolve(ok({ tasks: [task] }));
      if (u.includes('/workers')) return new Promise<Response>((resolve) => { resolveWorkers = resolve; });
      return Promise.resolve(ok({ schedules: [] }));
    });
    render(<TasksDashboard setRoute={() => {}} />);
    await waitFor(() => expect(screen.getByText('Loading workers…')).toBeTruthy());
    const workersCard = within(screen.getByRole('group', { name: 'Workers online' }));
    expect(workersCard.getByText('—')).toBeTruthy();
    await act(async () => resolveWorkers(ok({ workers: [] })));
    expect(workersCard.getByText('0')).toBeTruthy();
    expect(workersCard.queryByText('Loading workers…')).toBeNull();
    expect(workersCard.queryByText('unavailable')).toBeNull();
  });

  it('explains an empty workspace without presenting a made-up success rate', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('/tasks')) return Promise.resolve(ok({ tasks: [] }));
      if (String(input).includes('/workers')) return Promise.resolve(ok({ workers: [] }));
      return Promise.resolve(ok({ schedules: [] }));
    });
    render(<TasksDashboard setRoute={() => {}} />);
    await waitFor(() => expect(screen.getByText('No tasks registered yet')).toBeTruthy());
    expect(screen.getByText(/Start a worker to register its tasks/)).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Runs · last 24h' })).getByText('0')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Avg success rate' })).getByText('—')).toBeTruthy();
  });

  it('keeps real zero success and full task details while preserving keyboard navigation', async () => {
    const name = 'workspace.billing.send-invoices-with-a-long-task-name';
    const filePath = 'src/tasks/billing/invoices/send-recurring-customer-invoices.ts';
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('/tasks')) return Promise.resolve(ok({ tasks: [{ ...task, name, filePath, runs24h: 2, successRate: 0 }] }));
      if (String(input).includes('/workers')) return Promise.resolve(ok({ workers: [] }));
      return Promise.resolve(ok({ schedules: [] }));
    });
    const setRoute = vi.fn();
    render(<TasksDashboard setRoute={setRoute} />);
    const card = await screen.findByRole('button', { name: new RegExp(name) });
    expect(within(card).getByText(filePath)).toBeTruthy();
    expect(within(card).getByText('0%')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Avg success rate' })).getByText('0.0%')).toBeTruthy();
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(setRoute.mock.calls).toEqual([['runs'], ['runs']]);
  });

  it('averages only tasks with runs while retaining the simple per-task mean', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('/tasks')) return Promise.resolve(ok({ tasks: [
        task,
        { ...task, id: 'busy-task', name: 'busy-task', runs24h: 100, successRate: 50 },
        { ...task, id: 'unused-task', name: 'unused-task', runs24h: 0, successRate: null },
      ] }));
      if (String(input).includes('/workers')) return Promise.resolve(ok({ workers: [] }));
      return Promise.resolve(ok({ schedules: [] }));
    });
    render(<TasksDashboard setRoute={() => {}} />);
    const unused = await screen.findByRole('button', { name: /unused-task/ });
    expect(within(unused).getByText('No runs')).toBeTruthy();
    expect(within(unused).queryByText('0%')).toBeNull();
    const average = within(screen.getByRole('group', { name: 'Avg success rate' }));
    expect(average.getByText('75.0%')).toBeTruthy();
    expect(average.getByText('Average across tasks with runs')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Registered tasks' })).getByText('3')).toBeTruthy();
  });

  it('shows an unknown average when registered tasks have no recent runs', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('/tasks')) return Promise.resolve(ok({ tasks: [{ ...task, runs24h: 0, successRate: null }] }));
      if (String(input).includes('/workers')) return Promise.resolve(ok({ workers: [] }));
      return Promise.resolve(ok({ schedules: [] }));
    });
    render(<TasksDashboard setRoute={() => {}} />);
    await screen.findByText('No runs');
    const average = within(screen.getByRole('group', { name: 'Avg success rate' }));
    expect(average.getByText('—')).toBeTruthy();
    expect(average.getByText('No runs in the last 24 hours')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });
});
