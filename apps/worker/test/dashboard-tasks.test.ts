/* =============================================================================
   @better-trigger/worker — GET /tasks stats cache (PF1, todos/02-performance.md).

   The dashboard polls /tasks every 2s; every poll used to re-run the task
   list plus the runs aggregations, which grow with history when retention is
   off. The route now serves a short per-namespace cache (10s by default,
   BETTER_TRIGGER_STATS_TTL_MS) — a cache hit issues zero queries, and the
   cache never leaks from one namespace into another.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const kernel = {} as unknown as Kernel;

interface Stmt {
  sql: string;
  params: unknown[];
}

function makeApp() {
  const stmts: Stmt[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (sql.includes('FROM tasks')) {
        return {
          rows: [
            { id: 't1', name: 'one', file_path: null, trigger_source: 'api', cron_pattern: null },
          ],
        };
      }
      if (sql.includes('percentile_cont')) {
        return {
          rows: [{ task_id: 't1', runs24h: '3', p50: 10, p95: 20, success: '2', finished_total: '3' }],
        };
      }
      if (sql.includes('max(r.created_at)')) {
        return { rows: [{ task_id: 't1', last_run_at: new Date('2026-08-10T10:00:00.000Z') }] };
      }
      return { rows: [] }; // trend
    },
  } as unknown as Pool;
  return { app: createApp({ kernel, pool }), stmts };
}

const get = (qs = '') => new Request(`http://localhost:4848/api/v1/tasks${qs}`);

let savedKey: string | undefined;
let savedTtl: string | undefined;
beforeEach(() => {
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  savedTtl = process.env.BETTER_TRIGGER_STATS_TTL_MS;
  delete process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_STATS_TTL_MS;
  return () => {
    if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
    else process.env.BETTER_TRIGGER_API_KEY = savedKey;
    if (savedTtl === undefined) delete process.env.BETTER_TRIGGER_STATS_TTL_MS;
    else process.env.BETTER_TRIGGER_STATS_TTL_MS = savedTtl;
  };
});

describe('GET /tasks — stats cache', () => {
  it('serves a request within the TTL from cache, issuing zero queries', async () => {
    const { app, stmts } = makeApp();

    const first = await app.fetch(get());
    expect(first.status).toBe(200);
    const body = (await first.json()) as { tasks: Record<string, unknown>[] };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({
      id: 't1',
      runs24h: 3,
      p50Ms: 10,
      p95Ms: 20,
      successRate: 67,
      lastRunAt: '2026-08-10T10:00:00.000Z',
    });
    // Miss → task list + the three stats queries (agg, trend, lastRun).
    expect(stmts).toHaveLength(4);

    const second = await app.fetch(get());
    expect(await second.json()).toEqual(body);
    expect(stmts).toHaveLength(4); // cache hit: no new statements
  });

  it('keys the cache by namespace', async () => {
    const { app, stmts } = makeApp();

    await app.fetch(get('?projectId=acme&env=staging'));
    await app.fetch(get()); // default namespace: different key → miss
    await app.fetch(get()); // same key as #2 → hit

    expect(stmts).toHaveLength(8); // 4 + 4 + 0
  });

  it('re-queries once the TTL elapses (BETTER_TRIGGER_STATS_TTL_MS)', async () => {
    process.env.BETTER_TRIGGER_STATS_TTL_MS = '0'; // always stale → cache off
    const { app, stmts } = makeApp();

    await app.fetch(get());
    await app.fetch(get());

    expect(stmts).toHaveLength(8); // every request re-runs the queries
  });

  it('renders zero/null stats for a task with no runs (no per-task percentile)', async () => {
    const stmts: Stmt[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        if (sql.includes('FROM tasks')) {
          return {
            rows: [
              { id: 'idle', name: 'idle', file_path: null, trigger_source: 'api', cron_pattern: null },
            ],
          };
        }
        return { rows: [] };
      },
    } as unknown as Pool;
    const app = createApp({ kernel, pool });

    const res = await app.fetch(get());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Record<string, unknown>[] };
    expect(body.tasks[0]).toEqual({
      id: 'idle',
      name: 'idle',
      filePath: null,
      triggerSource: 'api',
      cronPattern: null,
      runs24h: 0,
      p50Ms: null,
      p95Ms: null,
      successRate: null,
      trend: new Array(12).fill(0),
      lastRunAt: null,
    });
    // The three stats queries ran once over the window — there is no
    // per-task percentile query for the idle task.
    expect(stmts.filter((s) => s.sql.includes('percentile_cont'))).toHaveLength(1);
  });

  it('does not alias namespaces whose parts contain "/" (cache key collision)', async () => {
    // {projectId:'a/b', env:'c'} and {projectId:'a', env:'b/c'} both joined
    // into 'a/b/c' under the old key scheme — they must stay separate caches.
    const stmts: Stmt[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        if (sql.includes('FROM tasks')) {
          const id = params[0] === 'a/b' ? 'task-proj' : 'task-env';
          return {
            rows: [{ id, name: id, file_path: null, trigger_source: 'api', cron_pattern: null }],
          };
        }
        return { rows: [] };
      },
    } as unknown as Pool;
    const app = createApp({ kernel, pool });
    const firstNs = new Request(
      'http://localhost:4848/api/v1/tasks?projectId=a%2Fb&env=c',
    );
    const secondNs = new Request(
      'http://localhost:4848/api/v1/tasks?projectId=a&env=b%2Fc',
    );

    const first = (await (await app.fetch(firstNs)).json()) as { tasks: { id: string }[] };
    const second = (await (await app.fetch(secondNs)).json()) as { tasks: { id: string }[] };
    // Each namespace sees its own task — nothing leaked across the colliding
    // keys.
    expect(first.tasks[0]!.id).toBe('task-proj');
    expect(second.tasks[0]!.id).toBe('task-env');
    expect(stmts).toHaveLength(8); // 4 + 4: two misses, no shared cache entry

    // And each one is cached under its own key afterwards.
    const again = (await (await app.fetch(firstNs)).json()) as { tasks: { id: string }[] };
    expect(again.tasks[0]!.id).toBe('task-proj');
    expect(stmts).toHaveLength(8); // third request: cache hit, zero queries
  });

  it('shares one query set across concurrent misses (single-flight)', async () => {
    const stmts: Stmt[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        await gate; // hold every query until both requests have arrived
        if (sql.includes('FROM tasks')) {
          return {
            rows: [
              { id: 't1', name: 'one', file_path: null, trigger_source: 'api', cron_pattern: null },
            ],
          };
        }
        if (sql.includes('percentile_cont')) {
          return {
            rows: [{ task_id: 't1', runs24h: '1', p50: 5, p95: 9, success: '1', finished_total: '1' }],
          };
        }
        if (sql.includes('max(r.created_at)')) {
          return { rows: [{ task_id: 't1', last_run_at: new Date('2026-08-10T10:00:00.000Z') }] };
        }
        return { rows: [] };
      },
    } as unknown as Pool;
    const app = createApp({ kernel, pool });

    const first = app.fetch(get());
    const second = app.fetch(get());
    release(); // both requests are now parked on the gate
    const [a, b] = await Promise.all([first, second]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // One miss served both waiters: a single task-list + stats query set.
    expect(stmts).toHaveLength(4);
  });

  it('re-queries after a failed load (the in-flight promise is dropped)', async () => {
    const stmts: Stmt[] = [];
    let fail = true;
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        if (fail) throw new Error('db down');
        if (sql.includes('FROM tasks')) {
          return {
            rows: [
              { id: 't1', name: 'one', file_path: null, trigger_source: 'api', cron_pattern: null },
            ],
          };
        }
        return { rows: [] };
      },
    } as unknown as Pool;
    const app = createApp({ kernel, pool });

    const first = await app.fetch(get());
    expect(first.status).toBe(500);
    expect(stmts).toHaveLength(4); // the failed miss ran the full query set

    fail = false; // the failure must not have poisoned the cache
    const second = await app.fetch(get());
    expect(second.status).toBe(200);
    expect(stmts).toHaveLength(8); // re-queried, then cached
  });
});
