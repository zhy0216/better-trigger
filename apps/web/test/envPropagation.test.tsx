/* =============================================================================
   Better Trigger — env propagation through every read/control call (p0-02).

   The TopBar EnvSwitcher picks prod/staging/dev; the client must carry that
   choice into run detail, cancel/retry, tasks, schedules and workers — not
   just the /runs list. These tests assert the URLs the client builds: every
   endpoint names `env` explicitly (`env=prod` is sent, not omitted), and
   passing `env="staging"` propagates it. A RunView render smoke test and a
   TasksDashboard render test confirm the UI wires the prop through.
   ============================================================================= */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setApiKey, type RunDetailResponse, type ServerRunStatus } from '../src/api/client';
import { RunView } from '../src/features/run/RunView';
import { TasksDashboard } from '../src/screens/TasksDashboard';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, statusText: 'Mapped' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setApiKey(null);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const urlOf = (call: number): string => String(fetchMock.mock.calls[call]?.[0]);

describe('env propagation — client URLs', () => {
  it('run detail names the env explicitly (staging passed, prod by default)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ run: {} }, 200)));
    await api.run('r1', 'staging');
    expect(urlOf(0)).toContain('env=staging');
    await api.run('r1');
    expect(urlOf(1)).toContain('env=prod');
  });

  it('cancelRun names the env explicitly', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ ok: true }, 200)));
    await api.cancelRun('r1', 'staging');
    expect(urlOf(0)).toContain('env=staging');
    await api.cancelRun('r1');
    expect(urlOf(1)).toContain('env=prod');
  });

  it('retryRun names the env explicitly without disturbing opts', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ runId: 'r2' }, 200)));
    await api.retryRun('r1', 'staging', { operationKey: 'k1' });
    expect(urlOf(0)).toContain('env=staging');
    await api.retryRun('r1');
    expect(urlOf(1)).toContain('env=prod');
  });

  it('tasks / schedules / workers name the env explicitly', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({}, 200)));
    await api.tasks('staging');
    await api.schedules('staging');
    await api.workers('staging');
    expect(urlOf(0)).toContain('env=staging');
    expect(urlOf(1)).toContain('env=staging');
    expect(urlOf(2)).toContain('env=staging');

    await api.tasks();
    await api.schedules();
    await api.workers();
    expect(urlOf(3)).toContain('env=prod');
    expect(urlOf(4)).toContain('env=prod');
    expect(urlOf(5)).toContain('env=prod');
  });

  it('setScheduleEnabled (PATCH) names the env explicitly', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ ok: true }, 200)));
    await api.setScheduleEnabled('s1', true, 'staging');
    expect(urlOf(0)).toContain('env=staging');
    await api.setScheduleEnabled('s1', true);
    expect(urlOf(1)).toContain('env=prod');
  });

  it('the /runs list keeps its existing filter-driven env behaviour', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ runs: [], nextCursor: null }, 200)));
    await api.runs({ env: 'staging' });
    expect(urlOf(0)).toContain('env=staging');
    await api.runs();
    expect(urlOf(1)).toContain('env=prod');
  });
});

/* ---- fixtures ------------------------------------------------------------- */
const BASE = Date.now();

const taskFixture = {
  id: 'task-a',
  name: 'task-a',
  filePath: 'tasks/task-a.ts',
  triggerSource: 'api',
  cronPattern: null,
  runs24h: 5,
  p50Ms: 100,
  p95Ms: 200,
  successRate: 99,
  trend: [],
  lastRunAt: null,
};

const workerFixture = {
  id: 'w1',
  name: 'web',
  codeVersion: 'v',
  runtime: 'node',
  tasks: ['task-a'],
  concurrency: 4,
  status: 'online',
  startedAt: new Date(BASE - 60_000).toISOString(),
  lastHeartbeatAt: new Date(BASE - 1000).toISOString(),
};

function detail(id: string, status: ServerRunStatus): RunDetailResponse {
  const running = status === 'running';
  return {
    run: {
      id,
      taskId: 't',
      status,
      trigger: 'api',
      codeVersion: 'v',
      projectId: 'default',
      env: 'prod',
      attempt: 1,
      maxAttempts: 3,
      durationMs: null,
      createdAt: new Date(BASE - 60_000).toISOString(),
      startedAt: new Date(BASE - 60_000).toISOString(),
      finishedAt: running ? null : new Date(BASE - 59_000).toISOString(),
      payload: null,
      output: null,
      error: null,
      parentRunId: null,
      idempotencyKey: null,
      queuedAt: new Date(BASE - 60_000).toISOString(),
    },
    steps: [],
    stepsTruncated: false,
    waits: [],
    waitsTruncated: false,
    logs: [],
    logsNextCursor: null,
  };
}

describe('env propagation — RunView', () => {
  it('fetches detail and cancels within the selected env', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/cancel')) return Promise.resolve(json({ ok: true }, 200));
      return Promise.resolve(json(detail('r1', 'running'), 200));
    });
    render(<RunView runId="r1" env="staging" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy());
    // The detail poll itself targets the staging namespace.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('env=staging');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([inp]) => String(inp).includes('/runs/r1/cancel'))).toBe(true),
    );
    const cancelCall = fetchMock.mock.calls.find(([inp]) => String(inp).includes('/runs/r1/cancel'));
    expect(String(cancelCall?.[0])).toContain('env=staging');
  });

  it('retries within the selected env', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/retry')) return Promise.resolve(json({ runId: 'r2' }, 200));
      return Promise.resolve(json(detail('r1', 'failed'), 200));
    });
    render(<RunView runId="r1" env="staging" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([inp]) => String(inp).includes('/runs/r1/retry'))).toBe(true),
    );
    const retryCall = fetchMock.mock.calls.find(([inp]) => String(inp).includes('/runs/r1/retry'));
    expect(String(retryCall?.[0])).toContain('env=staging');
  });
});

describe('env propagation — TasksDashboard', () => {
  it('passes the selected env into tasks/schedules/workers fetches', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/tasks')) return Promise.resolve(json({ tasks: [taskFixture] }, 200));
      if (u.includes('/schedules')) return Promise.resolve(json({ schedules: [] }, 200));
      if (u.includes('/workers')) return Promise.resolve(json({ workers: [workerFixture] }, 200));
      return Promise.resolve(json({}, 200));
    });
    render(<TasksDashboard setRoute={() => {}} env="staging" />);

    await waitFor(() => expect(screen.getByText('task-a')).toBeTruthy());

    const urls = fetchMock.mock.calls.map(([inp]) => String(inp));
    const tasksUrl = urls.find((u) => u.includes('/tasks'));
    const schedulesUrl = urls.find((u) => u.includes('/schedules'));
    const workersUrl = urls.find((u) => u.includes('/workers'));
    expect(tasksUrl).toContain('env=staging');
    expect(schedulesUrl).toContain('env=staging');
    expect(workersUrl).toContain('env=staging');
  });
});