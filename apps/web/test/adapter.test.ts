/* =============================================================================
   Better Trigger — server JSON → view-model adapter tests (O5).

   adaptTasks / adaptRuns / adaptRunDetail / adaptSchedules are the pure
   mapping layer between the /api/v1 response shapes and the dashboard's
   presentation types, so every interesting transformation (status vocabulary,
   relative-time formatting, the trace/span build, log grouping, schedule
   health vocabulary) is pinned here without any DOM or network.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import {
  adaptRun,
  adaptRunDetail,
  adaptSchedule,
  adaptTask,
  fmtDuration,
  mapStatus,
  relativeFuture,
  relativeTime,
} from '../src/api/adapter';
import type { RunDetailResponse, RunSummary, TaskSummary } from '../src/api/client';

const NOW = Date.parse('2026-08-11T12:00:00Z');

/* ---- status + duration + relative time ------------------------------------ */
describe('mapStatus', () => {
  it('maps the server vocabulary onto the UI vocabulary', () => {
    expect(mapStatus('queued')).toBe('queued');
    expect(mapStatus('running')).toBe('running');
    expect(mapStatus('waiting')).toBe('frozen');
    expect(mapStatus('completed')).toBe('success');
    expect(mapStatus('failed')).toBe('failed');
    expect(mapStatus('canceled')).toBe('canceled');
  });

  it('falls back to queued for a status the UI has never heard of', () => {
    // The dashboard renders first, then the server adds a status: it must
    // degrade to something renderable, not crash the list.
    expect(mapStatus('alien' as never)).toBe('queued');
  });
});

describe('fmtDuration', () => {
  it('formats sub-second and second-scale durations', () => {
    expect(fmtDuration(640)).toBe('640ms');
    expect(fmtDuration(2100)).toBe('2.10s');
    expect(fmtDuration(12345)).toBe('12.3s');
    expect(fmtDuration(null)).toBeNull();
    expect(fmtDuration(undefined)).toBeNull();
  });
});

describe('relativeTime', () => {
  it('renders just now / s / m / h / d windows', () => {
    expect(relativeTime(new Date(NOW - 1000).toISOString(), NOW)).toBe('just now');
    expect(relativeTime(new Date(NOW - 10_000).toISOString(), NOW)).toBe('10s ago');
    expect(relativeTime(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('3m ago');
    expect(relativeTime(new Date(NOW - 2 * 3_600_000).toISOString(), NOW)).toBe('2h ago');
    expect(relativeTime(new Date(NOW - 4 * 86_400_000).toISOString(), NOW)).toBe('4d ago');
  });

  it('degrades to an em dash for missing or unparseable timestamps', () => {
    expect(relativeTime(null, NOW)).toBe('—');
    expect(relativeTime('not-a-date', NOW)).toBe('—');
  });
});

describe('relativeFuture', () => {
  it('renders due / in Nm / in Nh / in Nd', () => {
    expect(relativeFuture(new Date(NOW - 1000).toISOString(), NOW)).toBe('due');
    expect(relativeFuture(new Date(NOW + 30_000).toISOString(), NOW)).toBe('in <1m');
    expect(relativeFuture(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toBe('in 5m');
    expect(relativeFuture(new Date(NOW + 3 * 3_600_000).toISOString(), NOW)).toBe('in 3h');
    expect(relativeFuture(new Date(NOW + 2 * 86_400_000 + 5 * 3_600_000).toISOString(), NOW)).toBe('in 2d 5h');
  });

  it('degrades to an em dash for missing timestamps', () => {
    expect(relativeFuture(null, NOW)).toBe('—');
  });
});

/* ---- tasks ---------------------------------------------------------------- */
describe('adaptTask', () => {
  it('maps a TaskSummary, defaulting missing fields', () => {
    const t: TaskSummary = {
      id: 'order-pipeline',
      name: 'order-pipeline',
      filePath: null,
      triggerSource: 'api',
      cronPattern: null,
      runs24h: 12,
      p50Ms: 640,
      p95Ms: null,
      successRate: null,
      trend: [],
      lastRunAt: null,
    };
    expect(adaptTask(t)).toEqual({
      id: 'order-pipeline',
      name: 'order-pipeline',
      file: '',
      runs24h: 12,
      p50: '640ms',
      p95: '—',
      success: 0,
      trend: [],
    });
  });
});

/* ---- runs ----------------------------------------------------------------- */
describe('adaptRun', () => {
  it('derives the started column from startedAt, falling back to createdAt', () => {
    const r: RunSummary = {
      id: 'r1',
      taskId: 't',
      status: 'completed',
      codeVersion: '0.1.0+abc',
      env: 'prod',
      trigger: 'api',
      attempt: 2,
      durationMs: 2100,
      createdAt: new Date(NOW - 10 * 60_000).toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const run = adaptRun(r, NOW);
    expect(run.status).toBe('success');
    expect(run.duration).toBe('2.10s');
    expect(run.attempts).toBe(2);
    expect(run.ts).toBe(NOW - 10 * 60_000);
    expect(run.started).toBe('10m ago');
    expect(run.version).toBe('0.1.0+abc');
  });
});

/* ---- run detail ----------------------------------------------------------- */
function detail(): RunDetailResponse {
  const run: import('../src/api/client').RunFull = {
    id: 'r1',
    taskId: 'order-pipeline',
    status: 'waiting',
    trigger: 'api',
    codeVersion: 'v9',
    projectId: 'default',
    env: 'prod',
    attempt: 1,
    maxAttempts: 3,
    durationMs: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    startedAt: new Date(NOW - 50_000).toISOString(),
    finishedAt: null,
    payload: { userId: 'u1' },
    output: null,
    error: null,
    parentRunId: null,
    idempotencyKey: null,
    queuedAt: new Date(NOW - 60_000).toISOString(),
  };
  return {
    run,
    steps: [
      {
        seq: 0,
        kind: 'step',
        label: 'load',
        status: 'completed',
        output: { user: 'u1' },
        error: null,
        attempt: 1,
        startedAt: new Date(NOW - 50_000).toISOString(),
        finishedAt: new Date(NOW - 49_000).toISOString(),
      },
      {
        seq: 1,
        kind: 'wait',
        label: '1h',
        status: 'completed',
        output: null,
        error: null,
        attempt: 1,
        startedAt: new Date(NOW - 49_000).toISOString(),
        finishedAt: null,
      },
      { seq: 2, kind: 'now', label: null, status: 'completed', output: null, error: null, attempt: 1, startedAt: null, finishedAt: null },
      { seq: 3, kind: 'random', label: null, status: 'completed', output: null, error: null, attempt: 1, startedAt: null, finishedAt: null },
      { seq: 4, kind: 'uuid', label: null, status: 'completed', output: null, error: null, attempt: 1, startedAt: null, finishedAt: null },
    ],
    stepsTruncated: false,
    waits: [{ id: 1, stepSeq: 1, kind: 'duration', resumeAt: new Date(NOW + 3_600_000).toISOString(), childRunId: null, status: 'pending' }],
    waitsTruncated: false,
    logs: [
      { id: 1, stepSeq: 0, level: 'info', message: 'loaded', data: null, ts: new Date(NOW - 49_500).toISOString() },
      { id: 2, stepSeq: null, level: 'warn', message: 'root line', data: null, ts: new Date(NOW - 48_000).toISOString() },
    ],
    logsNextCursor: null,
  };
}

describe('adaptRunDetail', () => {
  it('builds a root span plus one span per visible step, keyed logs, pending waits', () => {
    const { trace, spanLogs, status, pendingWaits } = adaptRunDetail(detail(), NOW);

    expect(status).toBe('frozen'); // waiting → frozen
    expect(trace.runId).toBe('r1');
    expect(trace.task).toBe('order-pipeline');
    expect(trace.payload).toEqual({ userId: 'u1' });

    // t0 = min(run.startedAt, steps). root + step + wait = 3 spans;
    // now/random/uuid are hidden.
    expect(trace.spans).toHaveLength(3);
    expect(trace.spans[0]).toMatchObject({
      id: 's0',
      label: 'order-pipeline',
      kind: 'task',
      level: 0,
      start: 0,
      status: 'frozen',
      attempt: '1 of 3',
    });
    expect(trace.spans[1]).toMatchObject({
      id: 's1',
      label: 'load',
      kind: 'fn',
      level: 1,
      start: 0,
      dur: 1000,
      status: 'success',
    });
    expect(trace.spans[1].error).toBeNull();

    // Step-seq'd log → its span; null-seq'd log → the root span.
    expect(spanLogs.s1).toEqual([['info', 'loaded', '500ms']]);
    expect(spanLogs.s0).toEqual([['warn', 'root line', '2000ms']]);

    // Only pending waits surface to the inspector.
    expect(pendingWaits).toEqual([
      { kind: 'duration', resumeAt: new Date(NOW + 3_600_000).toISOString(), childRunId: null },
    ]);
  });

  it('marks a running step as running and quantizes the non-terminal timeline to 5s', () => {
    const d = detail();
    const { trace } = adaptRunDetail(d, NOW);
    // The wait span (child index 1) never finished → running; totalMs
    // quantized up to the next 5s bucket.
    const waitSpan = trace.spans[2];
    expect(waitSpan.label).toBe('wait 1h');
    expect(waitSpan.status).toBe('running');
    expect(trace.totalMs % 5000).toBe(0);
  });

  it('uses real finishedAt for a terminal run and no quantization', () => {
    const d = detail();
    d.run.status = 'completed';
    d.run.finishedAt = new Date(NOW - 30_000).toISOString();
    d.run.durationMs = 20_000;
    d.steps[1] = { ...d.steps[1], finishedAt: new Date(NOW - 30_000).toISOString() };
    const { trace } = adaptRunDetail(d, NOW);
    expect(trace.spans[0].status).toBe('success');
    expect(trace.spans[1].status).toBe('success');
    expect(trace.totalMs).toBe(20_000);
  });
});

/* ---- schedules ------------------------------------------------------------- */
describe('adaptSchedule', () => {
  const base = {
    id: 'sch1',
    taskId: 'every-minute',
    cronPattern: '*/1 * * * *',
    cronTz: 'UTC',
    enabled: true,
    nextRunAt: new Date(NOW + 60_000).toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
  } as const satisfies Omit<import('../src/api/client').ScheduleSummary, 'lastRunStatus'> & {
    lastRunStatus: import('../src/api/client').ScheduleSummary['lastRunStatus'];
  };

  it('maps lastRunStatus onto the ok/warn vocabulary', () => {
    expect(adaptSchedule({ ...base, lastRunStatus: 'completed' }, NOW).last).toBe('ok');
    expect(adaptSchedule({ ...base, lastRunStatus: 'failed' }, NOW).last).toBe('warn');
    expect(adaptSchedule({ ...base, lastRunStatus: 'canceled' }, NOW).last).toBe('warn');
    expect(adaptSchedule({ ...base, lastRunStatus: null }, NOW).last).toBe('—');
  });

  it('humanizes common cron patterns', () => {
    expect(adaptSchedule(base, NOW).human).toBe('Every 1 minutes');
    expect(adaptSchedule({ ...base, cronPattern: '0 */2 * * *' }, NOW).human).toBe('Every 2 hours');
    expect(adaptSchedule({ ...base, cronPattern: '0 9 * * 1' }, NOW).human).toBe('Every Monday at 09:00');
    // Unknown shape stays raw.
    expect(adaptSchedule({ ...base, cronPattern: '0 9 * * 1,3' }, NOW).human).toBe('0 9 * * 1,3');
  });

  it('renders the next run as a relative future', () => {
    expect(adaptSchedule(base, NOW).next).toBe('in 1m');
  });
});
