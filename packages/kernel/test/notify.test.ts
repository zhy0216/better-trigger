/* =============================================================================
   @better-trigger/kernel — the notification write paths (PF2,
   todos/02-performance.md) send pg_notify inside their transactions.

   Every notification source must (a) run `SELECT pg_notify($1, $2)` on the
   channel 'bt', (b) send the right payload shape ({ type: 'work' } vs
   { type: 'terminal', runId, projectId, env }), and (c) only send when the tx
   actually did the thing — an idempotency conflict, an early no-op return or
   a branch that changes nothing must not notify.

   No Postgres: the kernel functions take a Pool, so a stub client that answers
   by query shape is enough — and it can record the exact notify statements the
   way a live server would deliver them.

   The statement is asserted to be the LAST one in the tx: NOTIFY is delivered
   at COMMIT, so a notify issued before the remaining mutations would land
   even when those later statements rolled back.
   ============================================================================= */
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import {
  batchTriggerChild,
  cancelRun,
  completeRun,
  createRun,
  failRun,
  retryRun,
  trigger,
} from '../src/runs';
import { NOTIFY_CHANNEL } from '../src/notify';
import { startOrchestrator } from '../src/orchestrator';

interface NotifiedCall {
  text: string;
  channel: string;
  payload: unknown;
}

type Handler = (text: string, params?: unknown[]) => {
  rows?: unknown[];
  rowCount?: number;
};

/** A run row shaped like the kernel's RunRow, configurable per test. */
function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run_1',
    task_id: 't1',
    status: 'running',
    attempt: 1,
    max_attempts: 3,
    recoveries: 0,
    max_recoveries: 10,
    parent_run_id: null,
    payload: null,
    project_id: DEFAULT_NAMESPACE.projectId,
    env: DEFAULT_NAMESPACE.env,
    concurrency_key: null,
    priority: 0,
    code_version: null,
    fencing_token: '1',
    ...overrides,
  };
}

/** A task row as createRunIn reads it. */
const TASK_ROW = { id: 't1', retry: null, concurrency_limit: null, latest_code_version: null };

/**
 * Build a stub pool. Client queries walk an ordered handler list (BEGIN/COMMIT/
 * pg_notify are special-cased); pool.query serves the orchestrator phase-1
 * scans. The notify statements are recorded with their text, channel and
 * parsed payload.
 */
function stubPool(opts: {
  handlers: Handler[];
  phase1?: (text: string, params?: unknown[]) => { rows: unknown[] };
}): { pool: Pool; notified: NotifiedCall[]; texts: string[] } {
  const notified: NotifiedCall[] = [];
  const texts: string[] = [];
  const client: PoolClient = {
    query: (async (text: string, params?: unknown[]) => {
      texts.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (/pg_notify/.test(text)) {
        notified.push({
          text,
          channel: String(params?.[0]),
          payload: JSON.parse(String(params?.[1])),
        });
        return { rows: [] };
      }
      const handler = opts.handlers.shift();
      if (!handler) throw new Error(`unexpected query: ${text.slice(0, 100)}`);
      const out = handler(text, params);
      return { rows: out.rows ?? [], rowCount: out.rowCount };
    }) as PoolClient['query'],
    release: () => {},
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
    query: (async (text: string, params?: unknown[]) => {
      if (!opts.phase1) return { rows: [] };
      return opts.phase1(text, params);
    }) as Pool['query'],
  } as unknown as Pool;
  return { pool, notified, texts };
}

/**
 * The notification must be the tx's LAST data statement: NOTIFY is only
 * delivered at COMMIT, so anything after it would either be rolled back (the
 * notify says "work exists" for work that vanished) or belong to a later tx.
 * Assert the statement pair [pg_notify, COMMIT] closes the transaction.
 */
const expectNotifyIsLastStatement = (texts: string[]): void => {
  expect(texts[texts.length - 1]).toBe('COMMIT');
  expect(texts[texts.length - 2]).toBe(`SELECT pg_notify($1, $2)`);
};

/**
 * Loop variant for the orchestrator tests, where ticks keep arriving while the
 * assertion runs: whatever follows the last pg_notify in the snapshot may only
 * be tx bookkeeping (the tx's own COMMIT, or a later tick's BEGIN/ROLLBACK) —
 * never a data mutation.
 */
const expectNotifyIsLastInTx = (texts: string[]): void => {
  let lastNotify = -1;
  for (let i = 0; i < texts.length; i++) {
    if (texts[i]!.includes('pg_notify')) lastNotify = i;
  }
  expect(lastNotify).toBeGreaterThanOrEqual(0);
  for (const t of texts.slice(lastNotify + 1)) {
    expect(['COMMIT', 'BEGIN', 'ROLLBACK']).toContain(t);
  }
};

const expectWork = (n: NotifiedCall[]) =>
  expect(n.map((c) => c.payload)).toEqual([{ type: 'work' }]);

function expectTerminal(n: NotifiedCall[], runId = 'run_1') {
  expect(n.map((c) => c.payload)).toEqual([
    {
      type: 'terminal',
      runId,
      projectId: DEFAULT_NAMESPACE.projectId,
      env: DEFAULT_NAMESPACE.env,
    },
  ]);
}

/** Statements the fenced paths share before their mutation. */
const FENCED_HEAD: Handler[] = [
  () => ({ rows: [{ locked_by: 'w1' }] }), // queue row lock
  () => ({ rows: [runRow()] }), // runs row lock
];

describe('notify sources — work notifications', () => {
  it('trigger enqueues and sends a bare work notification as the last statement', async () => {
    const { pool, notified, texts } = stubPool({
      handlers: [
        () => ({ rows: [TASK_ROW] }), // task config
        (_, params) => ({ rows: [{ id: String(params?.[0]) }] }), // INSERT runs
        () => ({ rows: [] }), // enqueue
      ],
    });
    const res = await trigger(pool, { taskId: 't1', payload: null, namespace: DEFAULT_NAMESPACE });
    expect(res.idempotent).toBe(false);
    expectWork(notified);
    expect(notified[0]!.channel).toBe(NOTIFY_CHANNEL);
    expect(notified[0]!.text).toBe(`SELECT pg_notify($1, $2)`);
    expectNotifyIsLastStatement(texts);
  });

  it('createRun does NOT notify on an idempotency conflict (no new work)', async () => {
    const { pool, notified } = stubPool({
      handlers: [
        () => ({ rows: [TASK_ROW] }),
        () => ({ rows: [] }), // INSERT runs returned nothing → conflict
        () => ({ rows: [{ id: 'run_existing' }] }), // the conflict lookup
      ],
    });
    const res = await createRun(pool, {
      taskId: 't1',
      payload: null,
      options: { idempotencyKey: 'k1' },
      triggerType: 'api',
      namespace: DEFAULT_NAMESPACE,
    });
    expect(res.idempotent).toBe(true);
    expect(notified).toEqual([]);
  });

  it('batchTriggerChild sends ONE aggregate work notification for the fan-out', async () => {
    const { pool, notified, texts } = stubPool({
      handlers: [
        ...FENCED_HEAD,
        () => ({ rows: [] }), // existing step check
        () => ({ rows: [TASK_ROW] }), // task preload (deduped: both items are t1)
        // The multi-row runs INSERT returns the pre-generated id of each
        // VALUES row (every 13th param, starting at the first).
        (_, params) => ({
          rows: (params ?? []).filter((_, i) => i % 13 === 0).map((id) => ({ id })),
        }),
        () => ({ rows: [] }), // enqueueMany
        () => ({ rows: [], rowCount: 1 }), // upsertStep
      ],
    });
    const res = await batchTriggerChild(pool, {
      runId: 'run_1',
      namespace: DEFAULT_NAMESPACE,
      seq: 1,
      items: [{ taskId: 't1', payload: null }, { taskId: 't1', payload: null }],
      workerId: 'w1',
      fencingToken: 1,
    });
    expect(res.runIds).toHaveLength(2);
    expectWork(notified);
    expectNotifyIsLastStatement(texts);
  });

  it('batchTriggerChild with no items records the step row and notifies without any batch SQL', async () => {
    const { pool, notified, texts } = stubPool({
      handlers: [
        ...FENCED_HEAD,
        () => ({ rows: [] }), // existing step check
        () => ({ rows: [], rowCount: 1 }), // upsertStep (empty runIds)
      ],
    });
    const res = await batchTriggerChild(pool, {
      runId: 'run_1',
      namespace: DEFAULT_NAMESPACE,
      seq: 1,
      items: [],
      workerId: 'w1',
      fencingToken: 1,
    });
    expect(res.runIds).toEqual([]);
    expectWork(notified);
    expectNotifyIsLastStatement(texts);
    // No preload / runs / queue INSERT for the empty fan-out.
    expect(texts.some((t) => /INSERT INTO (runs|queue)/.test(t))).toBe(false);
  });

  it('failRun retry branch sends work only (not terminal — waiters keep waiting)', async () => {
    const { pool, notified, texts } = stubPool({
      handlers: [
        ...FENCED_HEAD,
        () => ({ rowCount: 1 }), // UPDATE runs → queued
        () => ({ rowCount: 1 }), // UPDATE queue → released
      ],
    });
    const res = await failRun(pool, {
      runId: 'run_1',
      error: { message: 'boom' },
      workerId: 'w1',
      fencingToken: 1,
      namespace: DEFAULT_NAMESPACE,
    });
    expect(res.willRetry).toBe(true);
    expectWork(notified);
    expectNotifyIsLastStatement(texts);
  });

  it('retryRun sends work for the freshly-created run', async () => {
    const { pool, notified, texts } = stubPool({
      handlers: [
        () => ({ rows: [runRow({ status: 'failed' })] }), // source run read
        () => ({ rows: [TASK_ROW] }), // task config
        (_, params) => ({ rows: [{ id: String(params?.[0]) }] }), // INSERT runs
        () => ({ rows: [] }), // enqueue
      ],
    });
    await retryRun(pool, 'run_1', DEFAULT_NAMESPACE);
    expectWork(notified);
    expectNotifyIsLastStatement(texts);
  });
});

describe('notify sources — terminal notifications', () => {
  it('completeRun sends terminal (with the run id and namespace)', async () => {
    const { pool, notified, texts } = stubPool({
      handlers: [
        ...FENCED_HEAD,
        () => ({ rowCount: 1 }), // UPDATE runs → completed
        () => ({ rowCount: 1 }), // DELETE queue
      ],
    });
    await completeRun(pool, {
      runId: 'run_1',
      output: { ok: true },
      workerId: 'w1',
      fencingToken: 1,
      namespace: DEFAULT_NAMESPACE,
    });
    expectTerminal(notified);
    expect(notified[0]!.channel).toBe(NOTIFY_CHANNEL);
    expectNotifyIsLastStatement(texts);
  });

  it('completeRun with a parent sends terminal AND work (the parent may be claimable)', async () => {
    const { pool, notified, texts } = stubPool({
      handlers: [
        () => ({ rows: [{ locked_by: 'w1' }] }),
        () => ({ rows: [runRow({ parent_run_id: 'run_parent' })] }),
        () => ({ rowCount: 1 }),
        () => ({ rowCount: 1 }),
        // wakeParentIfWaiting's pending-wait lookup → no waiting parent
        () => ({ rows: [] }),
      ],
    });
    await completeRun(pool, {
      runId: 'run_1',
      output: { ok: true },
      workerId: 'w1',
      fencingToken: 1,
      namespace: DEFAULT_NAMESPACE,
    });
    expect(notified.map((c) => c.payload)).toEqual([
      { type: 'terminal', runId: 'run_1', projectId: 'default', env: 'prod' },
      { type: 'work' },
    ]);
    expectNotifyIsLastStatement(texts);
  });

  it('failRun no-retry branch sends terminal', async () => {
    const { pool, notified, texts } = stubPool({
      handlers: [
        () => ({ rows: [{ locked_by: 'w1' }] }),
        () => ({ rows: [runRow({ attempt: 3, max_attempts: 3 })] }),
        () => ({ rowCount: 1 }), // UPDATE runs → failed
        () => ({ rowCount: 1 }), // DELETE queue
        () => ({ rowCount: 1 }), // UPDATE waits → canceled
      ],
    });
    const res = await failRun(pool, {
      runId: 'run_1',
      error: { message: 'boom' },
      workerId: 'w1',
      fencingToken: 1,
      namespace: DEFAULT_NAMESPACE,
    });
    expect(res.willRetry).toBe(false);
    expectTerminal(notified);
    expectNotifyIsLastStatement(texts);
  });

  it('cancelRun sends terminal; the already-terminal no-op path sends nothing', async () => {
    const terminal = stubPool({
      handlers: [
        () => ({ rows: [{ locked_by: null }] }),
        () => ({ rows: [runRow({ status: 'queued' })] }),
        () => ({ rowCount: 1 }), // UPDATE runs → canceled
        () => ({ rowCount: 1 }), // DELETE queue
        () => ({ rowCount: 1 }), // UPDATE waits → canceled
      ],
    });
    await cancelRun(terminal.pool, 'run_1', DEFAULT_NAMESPACE);
    expectTerminal(terminal.notified);
    expectNotifyIsLastStatement(terminal.texts);

    const noop = stubPool({
      handlers: [
        () => ({ rows: [] }),
        () => ({ rows: [runRow({ status: 'completed' })] }),
      ],
    });
    await cancelRun(noop.pool, 'run_1', DEFAULT_NAMESPACE);
    expect(noop.notified).toEqual([]);
  });
});

describe('notify sources — orchestrator loops', () => {
  const waitFor = async (pred: () => boolean, timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const quietLogger = { warn: () => {}, error: () => {} };
  const WAITS_ONLY = { cron: false, reaper: false, workerOffline: false, timerIntervalMs: 10 };
  const CRON_ONLY = { waits: false, reaper: false, workerOffline: false, cronIntervalMs: 10 };

  it('scanWaits resume sends work (the resumed run is claimable again)', async () => {
    const { pool, notified, texts } = stubPool({
      phase1: () => ({
        rows: [
          {
            id: 1,
            run_id: 'run_wait',
            project_id: 'default',
            env: 'prod',
            step_seq: 1,
            fingerprint: null,
            kind: 'duration',
            child_run_id: null,
          },
        ],
      }),
      handlers: [
        () => ({ rows: [] }), // position-1 queue row (absent for a waiting run)
        () => ({ rows: [runRow({ id: 'run_wait', status: 'waiting' })] }), // tryLockRunRow
        () => ({ rows: [{ id: 1 }] }), // wait row lock
        () => ({ rowCount: 1 }), // UPDATE waits → completed
        () => ({ rows: [], rowCount: 1 }), // upsertStep
        () => ({ rowCount: 1 }), // UPDATE runs → queued
        () => ({ rows: [] }), // INSERT queue
      ],
    });
    const handle = startOrchestrator(pool, quietLogger, WAITS_ONLY);
    try {
      await waitFor(() => notified.length > 0);
      // Snapshot: the loop keeps ticking (and would keep resuming the same due
      // wait), so the assertion applies to the tx as observed.
      expectNotifyIsLastInTx([...texts]);
    } finally {
      handle.stop();
    }
    expectWork(notified);
  });

  it('scanCron sends one aggregate work notification for the fired schedules', async () => {
    const { pool, notified, texts } = stubPool({
      handlers: [
        () => ({
          rows: [
            {
              id: 'sched_1',
              task_id: 't1',
              cron_pattern: '* * * * *',
              cron_tz: null,
              project_id: 'default',
              env: 'prod',
            },
          ],
        }),
        () => ({ rows: [TASK_ROW] }),
        (_, params) => ({ rows: [{ id: String(params?.[0]) }] }),
        () => ({ rows: [] }), // enqueue
        () => ({ rowCount: 1 }), // UPDATE schedules
      ],
    });
    const handle = startOrchestrator(pool, quietLogger, CRON_ONLY);
    try {
      await waitFor(() => notified.length > 0);
      // Snapshot before the loop's next tick consumes (and fails on) the
      // exhausted handler list.
      expectNotifyIsLastInTx([...texts]);
    } finally {
      handle.stop();
    }
    expectWork(notified);
  });
});
