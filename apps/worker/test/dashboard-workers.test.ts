/* =============================================================================
   @better-trigger/worker — GET /workers is bounded (todos/02-performance.md PF6).

   `workers` is an append-only history: one row per process start, and going
   offline only flips `status`. The route used to be
   `SELECT ... FROM workers ORDER BY started_at DESC` — no filter, no LIMIT —
   so a week of `bun --watch` reloads turned the dashboard's workers page into a
   full serialization of every daemon that ever booted.

   Driven through createApp with a stub pool (no Postgres): what is pinned is
   the SQL the route builds — an always-present LIMIT, online-only by default,
   the escape hatches for the other two views, and that both knobs travel as
   bind parameters rather than string concatenation.
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
      return { rows: [] };
    },
  } as unknown as Pool;
  return { app: createApp({ kernel, pool }), stmts };
}

const get = (qs = '') => new Request(`http://localhost:4848/api/v1/workers${qs}`);

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_API_KEY;
  return () => {
    if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
    else process.env.BETTER_TRIGGER_API_KEY = savedKey;
  };
});

describe('GET /workers', () => {
  it('is online-only, namespace-scoped and limited by default', async () => {
    const { app, stmts } = makeApp();

    const res = await app.fetch(get());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workers: [] });
    const q = stmts[0]!;
    expect(q.sql).toMatch(/WHERE status = \$1/);
    // The default namespace (default/prod) is always predicated on — a
    // dashboard pointed at nothing still only ever lists one namespace.
    expect(q.sql).toMatch(/project_id = \$2 AND env = \$3/);
    expect(q.sql).toMatch(/LIMIT \$4/);
    expect(q.params).toEqual(['online', 'default', 'prod', 50]);
  });

  it('keeps the namespace predicate (and the LIMIT) under status=all', async () => {
    const { app, stmts } = makeApp();

    await app.fetch(get('?status=all'));

    const q = stmts[0]!;
    // status=all drops the status clause — the namespace scope and the LIMIT
    // stay; the LIMIT moves to $3.
    expect(q.sql).not.toMatch(/status = \$\d/);
    expect(q.sql).toMatch(/WHERE project_id = \$1 AND env = \$2/);
    expect(q.sql).toMatch(/LIMIT \$3/);
    expect(q.params).toEqual(['default', 'prod', 50]);
  });

  it('can be asked for the offline history explicitly', async () => {
    const { app, stmts } = makeApp();

    await app.fetch(get('?status=offline&limit=5'));

    expect(stmts[0]!.params).toEqual(['offline', 'default', 'prod', 5]);
  });

  it('caps an oversized limit instead of honouring it', async () => {
    const { app, stmts } = makeApp();

    await app.fetch(get('?limit=100000'));

    expect(stmts[0]!.params).toEqual(['online', 'default', 'prod', 200]);
  });

  it('rejects a status it does not know rather than filtering on it', async () => {
    const { app, stmts } = makeApp();

    // Straight into `WHERE status = $1`, so an unknown value must not reach pg
    // as a silent "matches nothing" — and the parameter must never be spliced.
    const res = await app.fetch(get('?status=DROP'));

    expect(res.status).toBe(400);
    expect(stmts).toEqual([]);
  });

  it('rejects a non-integer limit', async () => {
    const { app, stmts } = makeApp();

    const res = await app.fetch(get('?limit=abc'));

    expect(res.status).toBe(400);
    expect(stmts).toEqual([]);
  });

  it('maps rows onto the WorkerSummary wire shape', async () => {
    const stmts: Stmt[] = [];
    const started = new Date('2026-07-30T08:00:00.000Z');
    const beat = new Date('2026-07-30T08:01:00.000Z');
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        return {
          rows: [
            {
              id: 'wrk_1',
              name: 'laptop',
              code_version: 'abc123',
              runtime: 'bun',
              tasks: ['t1'],
              concurrency: 5,
              status: 'online',
              started_at: started,
              last_heartbeat_at: beat,
            },
          ],
        };
      },
    } as unknown as Pool;

    const res = await createApp({ kernel, pool }).fetch(get());

    expect(await res.json()).toEqual({
      workers: [
        {
          id: 'wrk_1',
          name: 'laptop',
          codeVersion: 'abc123',
          runtime: 'bun',
          tasks: ['t1'],
          concurrency: 5,
          status: 'online',
          startedAt: started.toISOString(),
          lastHeartbeatAt: beat.toISOString(),
        },
      ],
    });
  });
});
