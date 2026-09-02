/* =============================================================================
   @better-trigger/worker — GET /runs keyset pagination loses no rows at
   sub-millisecond precision (round-3 T2).

   pg `timestamptz` carries microseconds; JS Dates truncate to milliseconds.
   A cursor minted from `created_at.toISOString()` therefore describes a moment
   strictly EARLIER than the page's last row, and rows whose created_at falls
   between the truncated value and the real one — same millisecond, later
   microsecond, so they sort BEFORE the boundary under `ORDER BY created_at
   DESC` — never satisfy `created_at < $cursor` and vanish from the walk.
   Batch triggers make this reachable at scale: every run in one transaction
   shares the same `now()`, down to the microsecond.

   The other cursor tests drive an empty-result stub, which cannot see any of
   this. Here the fake pool evaluates the very keyset predicate the route
   builds, comparing full-precision timestamps the way Postgres would, so a
   walk page-by-page with the server's own nextCursor must return every row
   exactly once, in order.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel } from '@better-trigger/kernel';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const kernel = {} as unknown as Kernel;

interface StubRow {
  id: string;
  /** Full-precision UTC timestamp, microsecond suffix included ('…Z'). */
  us: string;
}

interface Page {
  runs: { id: string; createdAt: string }[];
  nextCursor: string | null;
}

/** Compare like Postgres: same-format ISO strings order chronologically once
 *  the fractional half is padded to microseconds ('.456Z' === '.456000'). */
const normalize = (ts: string): string => {
  const z = ts.endsWith('Z') ? ts.slice(0, -1) : ts;
  const dot = z.indexOf('.');
  return dot === -1 ? `${z}.000000Z` : `${z.slice(0, dot + 7)}Z`;
};

function makeApp(rows: StubRow[], stmts: { sql: string; params: unknown[] }[]) {
  const desc = (x: string, y: string): number => (x < y ? 1 : x > y ? -1 : 0);
  const sorted = [...rows].sort((a, b) => desc(normalize(a.us), normalize(b.us)) || desc(a.id, b.id));
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (!/FROM runs/.test(sql)) return { rows: [] };
      // The route's binding shapes: [projectId, env, (limit+1)] or
      // [projectId, env, cursorTs, cursorId, (limit+1)].
      const keyed = params.length === 5;
      const limit = params[params.length - 1] as number;
      let page = sorted;
      if (keyed) {
        const cTs = normalize(String(params[2]));
        const cId = String(params[3]);
        page = sorted.filter((r) => {
          const us = normalize(r.us);
          return us < cTs || (us === cTs && r.id < cId);
        });
      }
      const hasMore = page.length > limit;
      const take = (hasMore ? page.slice(0, limit) : page).map((r) => ({
        id: r.id,
        task_id: 'task-a',
        status: 'queued',
        trigger_type: 'api',
        code_version: null,
        env: 'prod',
        attempt: 1,
        // What the pg driver hands back for a timestamptz: ms-truncated.
        created_at: new Date(`${r.us.slice(0, 23)}Z`),
        // The full-precision half the route mints cursors from.
        created_at_us: r.us.slice(0, -1),
        started_at: null,
        finished_at: null,
      }));
      return { rows: take };
    },
  } as unknown as Pool;
  const app = createApp({ kernel, pool });
  const fetchPage = async (cursor?: string): Promise<Page> => {
    const qs = new URLSearchParams({ limit: '2' });
    if (cursor) qs.set('cursor', cursor);
    const res = await app.fetch(
      new Request(`http://localhost:4848/api/v1/runs?${qs.toString()}`),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Page;
  };
  /** Walk every page with the server's own cursors. */
  const walk = async (): Promise<{ ids: string[]; cursorTs: string[] }> => {
    const ids: string[] = [];
    const cursorTs: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await fetchPage(cursor);
      ids.push(...page.runs.map((r) => r.id));
      if (page.nextCursor === null) break;
      cursorTs.push(page.nextCursor.split('|')[0]!);
      cursor = page.nextCursor;
      expect(ids.length, 'walk must terminate inside the row count').toBeLessThanOrEqual(rows.length);
    }
    return { ids, cursorTs };
  };
  return { app, fetchPage, walk, stmts };
}

describe('GET /runs keyset pagination (microsecond-safe cursor)', () => {
  it('walks batch rows that share now() to the microsecond without loss or repeats', async () => {
    // The exact batch-trigger shape: one transaction, one now(), six identical
    // timestamps ordered by id. A ms-truncated cursor (.456Z for .456789Z)
    // makes every remaining row "newer" than the cursor and the walk silently
    // ends after the first page.
    const rows = ['run_01', 'run_02', 'run_03', 'run_04', 'run_05', 'run_06'].map((id) => ({
      id,
      us: '2026-07-30T08:00:00.456789Z',
    }));
    const stmts: { sql: string; params: unknown[] }[] = [];
    const { walk } = makeApp(rows, stmts);
    const { ids, cursorTs } = await walk();
    expect(ids).toEqual(['run_06', 'run_05', 'run_04', 'run_03', 'run_02', 'run_01']);
    expect(cursorTs.every((ts) => /\.\d{6}Z$/.test(ts))).toBe(true);
  });

  it('walks same-millisecond rows with distinct sub-millisecond stamps without gaps', async () => {
    // All five share the millisecond .4xx; ordering by truncated ms alone (or
    // filtering with a truncated cursor) drops .499500 between the first two
    // pages.
    const rows = [
      { id: 'run_a', us: '2026-07-30T08:00:00.500000Z' },
      { id: 'run_b', us: '2026-07-30T08:00:00.499998Z' },
      { id: 'run_c', us: '2026-07-30T08:00:00.499500Z' },
      { id: 'run_d', us: '2026-07-30T08:00:00.400000Z' },
      { id: 'run_e', us: '2026-07-30T08:00:00.300000Z' },
    ];
    const stmts: { sql: string; params: unknown[] }[] = [];
    const { walk, fetchPage } = makeApp(rows, stmts);
    const { ids } = await walk();
    expect(ids).toEqual(['run_a', 'run_b', 'run_c', 'run_d', 'run_e']);

    // The cursor bound to pg keeps the microseconds it was minted with.
    const first = await fetchPage();
    expect(first.nextCursor).toBe('2026-07-30T08:00:00.499998Z|run_b');
    await fetchPage(first.nextCursor!);
    const lastStmt = stmts.at(-1)!;
    expect(lastStmt.params[2]).toBe('2026-07-30T08:00:00.499998Z');
  });

  it('still mints no cursor for the final page', async () => {
    const rows = [
      { id: 'run_1', us: '2026-07-30T08:00:00.456789Z' },
      { id: 'run_2', us: '2026-07-30T08:00:00.456789Z' },
    ];
    const stmts: { sql: string; params: unknown[] }[] = [];
    const { fetchPage } = makeApp(rows, stmts);
    const page = await fetchPage();
    expect(page.runs.map((r) => r.id)).toEqual(['run_2', 'run_1']);
    expect(page.nextCursor).toBeNull();
  });
});
