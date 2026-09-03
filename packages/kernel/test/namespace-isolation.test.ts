/* =============================================================================
   @better-trigger/kernel — C2 namespace isolation (projectId + env).

   The isolation contract, pinned at the SQL level against stub clients (no
   Postgres):

     - idempotency is per namespace: the same task + idempotency key in two
       namespaces must resolve two DIFFERENT existing runs — the unique index
       and the conflict lookup are both (project_id, env, …)-scoped;
     - a claim can only ever take runs inside the worker's namespace pairs: the
       candidate scan runs once per namespace with constant (project_id, env)
       equalities (p1-08) — two separate `= ANY` arrays would combine in a
       cartesian product and leak runs across namespaces;
     - the concurrency-limiter advisory lock key embeds the namespace, so prod
       and staging throttle independently and can never serialize each other;
     - every SQL statement in the kernel that touches a namespace-scoped table
       carries a namespace marker (project_id / env / namespaces), with a small
       documented allowlist of statements keyed by globally-unique ids or ids
       selected by an already-scoped statement.
   ============================================================================= */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Namespace } from '@better-trigger/core';
import { heartbeat, releaseClaims, scanStrandedRuns, claimRuns } from '../src/queue';
import { createRunIn } from '../src/runs';
import { prune } from '../src/prune';

const NS_STAGING: Namespace = { projectId: 'acme', env: 'staging' };
const NS_PROD: Namespace = { projectId: 'acme', env: 'prod' };

/* ---------------------------------------------------------------------------
 * Idempotency isolation
 * ------------------------------------------------------------------------- */

/**
 * A client that answers the tasks lookup, then simulates an idempotency
 * conflict: the INSERT ... ON CONFLICT DO NOTHING returns no row, and the
 * follow-up lookup hands back the pre-existing run.
 */
function conflictClient() {
  const stmts: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM tasks/.test(sql)) {
        return {
          rows: [{ id: 't', retry: null, concurrency_limit: null, latest_code_version: null }],
        };
      }
      // createRunIn's database-clock read (T1).
      if (/^SELECT now\(\)/.test(sql)) return { rows: [{ now: new Date() }] };
      if (/INSERT INTO runs/.test(sql)) return { rows: [] };
      if (/SELECT id FROM runs/.test(sql)) return { rows: [{ id: 'existing_run' }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, stmts };
}

describe('idempotency is per namespace (C2)', () => {
  it('scopes the idempotency lookup by (project_id, env, task_id, key)', async () => {
    const a = conflictClient();
    const resA = await createRunIn(a.client, {
      taskId: 't',
      payload: null,
      options: { idempotencyKey: 'k' },
      triggerType: 'api',
      namespace: NS_STAGING,
    });
    const b = conflictClient();
    const resB = await createRunIn(b.client, {
      taskId: 't',
      payload: null,
      options: { idempotencyKey: 'k' },
      triggerType: 'api',
      namespace: NS_PROD,
    });

    const lookup = (stmts: { sql: string; params: unknown[] }[]) =>
      stmts.find((s) => /SELECT id FROM runs/.test(s.sql))!;
    expect(lookup(a.stmts).params).toEqual(['acme', 'staging', 't', 'k']);
    expect(lookup(b.stmts).params).toEqual(['acme', 'prod', 't', 'k']);
    // Both resolve as idempotent hits — each against ITS OWN namespace's run.
    expect(resA).toEqual({ runId: 'existing_run', idempotent: true });
    expect(resB).toEqual({ runId: 'existing_run', idempotent: true });
  });

  it('scopes the ON CONFLICT target by (project_id, env, task_id, idempotency_key)', async () => {
    const { client, stmts } = conflictClient();
    await createRunIn(client, {
      taskId: 't',
      payload: null,
      options: { idempotencyKey: 'k' },
      triggerType: 'api',
      namespace: NS_STAGING,
    });

    const insert = stmts.find((s) => /INSERT INTO runs/.test(s.sql))!;
    expect(insert.sql).toMatch(
      /ON CONFLICT \(project_id, env, task_id, idempotency_key\)/,
    );
    expect(insert.sql).not.toMatch(/ON CONFLICT \(task_id, idempotency_key\)/);
  });

  it('scopes the task lookup a trigger resolves against', async () => {
    const { client, stmts } = conflictClient();
    await createRunIn(client, {
      taskId: 't',
      payload: null,
      triggerType: 'api',
      namespace: NS_STAGING,
    });

    const task = stmts.find((s) => /FROM tasks/.test(s.sql))!;
    expect(task.sql).toMatch(/WHERE project_id = \$1 AND env = \$2 AND id = \$3/);
    expect(task.params).toEqual(['acme', 'staging', 't']);
  });
});

/* ---------------------------------------------------------------------------
 * Claim isolation
 * ------------------------------------------------------------------------- */

function claimPool(candidateRows: unknown[]) {
  const stmts: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (/FROM queue q/.test(sql)) return { rows: candidateRows };
      if (/RETURNING fencing_token/.test(sql)) return { rows: [{ fencing_token: '1' }], rowCount: 1 };
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: '1' }] };
      return { rows: [] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, stmts };
}

describe('claim scoping (C2)', () => {
  it('scans one candidate SELECT per namespace, each a constant-equality pair', async () => {
    const { pool, stmts } = claimPool([]);

    await claimRuns(pool, {
      workerId: 'w1',
      namespaces: [NS_STAGING, NS_PROD],
      taskIds: ['t'],
      limit: 1,
      leaseMs: 60_000,
    });

    const cands = stmts.filter((s) => /FROM queue q/.test(s.sql));
    // p1-08: the claim hot path scans one namespace at a time, so a worker
    // serving two namespaces issues two candidate SELECTs — each a pair of
    // constant equalities. The q-side is what binds queue_claimable_idx's
    // leading (project_id, env) columns directly; the r-side repeats the
    // equality so the semantics are explicit instead of smuggled through the
    // join.
    expect(cands).toHaveLength(2);
    for (const cand of cands) {
      expect(cand.sql).toMatch(/q\.project_id = \$3::text AND q\.env = \$4::text/);
      expect(cand.sql).toMatch(/r\.project_id = \$3::text AND r\.env = \$4::text/);
      // A single VALUES list over both pairs would be a semi-join that sheds
      // the index's leading-column equalities; separate `= ANY` arrays would
      // combine in a cartesian product — a worker serving (acme, staging) +
      // (other, prod) could claim runs in (acme, prod). The per-namespace
      // scans close both: each constrains project_id AND env to one exact
      // pair, so the pairing can never leak.
      expect(cand.sql).not.toMatch(/r\.project_id = ANY/);
      expect(cand.sql).not.toMatch(/r\.env = ANY/);
      expect(cand.sql).not.toMatch(/IN \(VALUES/);
    }
    // Task ids + window + THIS namespace's pair, per scan.
    expect(cands[0]!.params).toEqual([['t'], 10, 'acme', 'staging']);
    expect(cands[1]!.params).toEqual([['t'], 10, 'acme', 'prod']);
  });

  it('matches the task config join on the run namespace too', async () => {
    const { pool, stmts } = claimPool([]);

    await claimRuns(pool, {
      workerId: 'w1',
      namespaces: [NS_STAGING],
      taskIds: ['t'],
      limit: 1,
      leaseMs: 60_000,
    });

    // A staging run must not pick up the prod task row's concurrency limit.
    const cand = stmts.find((s) => /FROM queue q/.test(s.sql))!;
    expect(cand.sql).toMatch(/t\.id = r\.task_id\s+AND t\.project_id = r\.project_id AND t\.env = r\.env/);
  });

  it('namespaces the concurrency advisory lock key', async () => {
    const { pool, stmts } = claimPool([
      {
        queue_id: 1,
        run_id: 'run_1',
        task_id: 't',
        payload: {},
        attempt: 0,
        max_attempts: 3,
        code_version: null,
        project_id: 'acme',
        env: 'staging',
        concurrency_key: 'tenant-1',
        concurrency_limit: 1,
      },
    ]);

    await claimRuns(pool, {
      workerId: 'w1',
      namespaces: [NS_STAGING],
      taskIds: ['t'],
      limit: 1,
      leaseMs: 60_000,
    });

    const lock = stmts.find((s) => /pg_advisory_xact_lock/.test(s.sql))!;
    expect(lock.params[1]).toBe('bt:cc:acme:staging:tenant-1');
    // And the running-count is namespace-scoped, so prod/staging throttle
    // independently instead of sharing one budget.
    const count = stmts.find((s) => /count\(\*\)/.test(s.sql))!;
    expect(count.sql).toMatch(/project_id = \$2 AND env = \$3/);
  });

  it('returns the claimed run with its namespace', async () => {
    const { pool } = claimPool([
      {
        queue_id: 1,
        run_id: 'run_1',
        task_id: 't',
        payload: {},
        attempt: 1,
        max_attempts: 3,
        code_version: null,
        project_id: 'acme',
        env: 'staging',
        concurrency_key: null,
        concurrency_limit: null,
      },
    ]);

    const claimed = await claimRuns(pool, {
      workerId: 'w1',
      namespaces: [NS_STAGING],
      taskIds: ['t'],
      limit: 1,
      leaseMs: 60_000,
    });

    expect(claimed[0]?.projectId).toBe('acme');
    expect(claimed[0]?.env).toBe('staging');
  });
});

/* ---------------------------------------------------------------------------
 * Placeholder/param alignment (P0 regression)
 *
 * namespacePredicate() / nsPredicateFor() number their placeholders from
 * params.length + 1, so the caller must pre-fill ONE params array with
 * everything that comes before the predicate in SQL order. A fresh array made
 * the predicate restart at $1 and collide with the literal $n of the earlier
 * clauses — invisible to the shape-stub tests (they never bind against real
 * Postgres), fatal on one. With a single namespace the predicate is a pair of
 * constant equalities (p1-08); with two+ it is the VALUES pairing, and claimRuns
 * skips that form entirely by scanning once per namespace. These pin the
 * concrete statement+params pairs, and a generic alignment check (max
 * placeholder === param count, every $1..$N present) catches any future offset
 * in any of the paths.
 * ------------------------------------------------------------------------- */

function expectAligned(sql: string, params: unknown[]): void {
  const nums = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const max = Math.max(0, ...nums);
  expect(max, `placeholder max ${max} ≠ ${params.length} params in:\n${sql}`).toBe(
    params.length,
  );
  for (let i = 1; i <= max; i++) {
    expect(nums, `placeholder $${i} missing in:\n${sql}`).toContain(i);
  }
}

function recordPool(handlers: Array<(sql: string, params: unknown[]) => unknown>) {
  const stmts: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    stmts.push({ sql, params });
    for (const h of handlers) {
      const out = h(sql, params);
      if (out !== undefined) return out;
    }
    return { rows: [], rowCount: 0 };
  };
  const client = {
    query,
    release: () => {},
  };
  return {
    pool: { connect: async () => client, query } as unknown as Pool,
    stmts,
  };
}

describe('placeholder/param alignment on namespace predicates (P0)', () => {
  it('claimRuns numbers the namespace pair after taskIds + window, per scan', async () => {
    const { pool, stmts } = claimPool([]);

    await claimRuns(pool, {
      workerId: 'w1',
      namespaces: [NS_STAGING, NS_PROD],
      taskIds: ['t'],
      limit: 2,
      leaseMs: 60_000,
    });

    const cands = stmts.filter((s) => /FROM queue q/.test(s.sql));
    // p1-08: one scan per namespace — each carries its OWN ns pair, so there
    // is no VALUES list to align, just two constant equalities (q + r) sharing
    // one param pair.
    expect(cands).toHaveLength(2);
    for (const cand of cands) {
      expectAligned(cand.sql, cand.params);
      // $1 taskIds, $2 window, then THIS namespace's pair.
      expect(cand.sql).toMatch(
        /JOIN runs r ON r\.id = q\.run_id\s+AND r\.project_id = q\.project_id AND r\.env = q\.env/,
      );
      expect(cand.sql).toMatch(/q\.project_id = \$3::text AND q\.env = \$4::text/);
      expect(cand.sql).toMatch(/r\.project_id = \$3::text AND r\.env = \$4::text/);
    }
    expect(cands[0]!.params).toEqual([['t'], 10, 'acme', 'staging']);
    expect(cands[1]!.params).toEqual([['t'], 10, 'acme', 'prod']);
  });

  it('claimRuns pinned numbers the namespace pair after the code versions', async () => {
    const { pool, stmts } = claimPool([]);

    await claimRuns(pool, {
      workerId: 'w1',
      namespaces: [NS_STAGING],
      taskIds: ['t'],
      limit: 1,
      leaseMs: 60_000,
      codeVersions: ['v1'],
    });

    const cand = stmts.find((s) => /FROM queue q/.test(s.sql))!;
    expectAligned(cand.sql, cand.params);
    // $1 taskIds, $2 window, $3 codeVersions, then the namespace pair.
    expect(cand.params).toEqual([['t'], 10, ['v1'], 'acme', 'staging']);
    expect(cand.sql).toMatch(/unnest\(\$1::text\[\], \$3::text\[\]\)/);
    expect(cand.sql).toMatch(/q\.project_id = \$4::text AND q\.env = \$5::text/);
    expect(cand.sql).toMatch(/r\.project_id = \$4::text AND r\.env = \$5::text/);
  });

  it('heartbeat numbers the renewal and cancel-check predicates after their clauses', async () => {
    const { pool, stmts } = recordPool([
      (sql) => (/UPDATE queue/.test(sql) ? { rows: [{ run_id: 'r1' }] } : undefined),
      // The workers liveness touch must report a row (rowCount 0 = pruned row
      // → not_found; see the heartbeat T7 guard).
      (sql) => (/UPDATE workers/.test(sql) ? { rows: [], rowCount: 1 } : undefined),
      (sql) => (/FROM runs/.test(sql) ? { rows: [] } : undefined),
    ]);

    await heartbeat(pool, {
      workerId: 'w1',
      namespaces: [NS_STAGING],
      runIds: ['r1', 'r2'],
      leaseMs: 60_000,
    });

    const renew = stmts.find((s) => /UPDATE queue/.test(s.sql))!;
    expectAligned(renew.sql, renew.params);
    // $1 leaseMs, $2 workerId, $3 runIds, then the namespace pair.
    expect(renew.params).toEqual(['60000', 'w1', ['r1', 'r2'], 'acme', 'staging']);
    expect(renew.sql).toMatch(/queue\.project_id = \$4::text AND queue\.env = \$5::text/);

    const cancel = stmts.find((s) => /SELECT id FROM runs/.test(s.sql))!;
    expectAligned(cancel.sql, cancel.params);
    // $1 runIds, then the namespace pair.
    expect(cancel.params).toEqual([['r1', 'r2'], 'acme', 'staging']);
    expect(cancel.sql).toMatch(/runs\.project_id = \$2::text AND runs\.env = \$3::text/);
  });

  it('scanStrandedRuns numbers the predicate after the LIMIT and window params', async () => {
    const sqls: string[] = [];
    const paramLists: unknown[][] = [];
    const pool = {
      query: async (sql: string, p: unknown[] = []) => {
        sqls.push(sql);
        paramLists.push(p);
        return { rows: [] };
      },
    } as unknown as Pool;

    await scanStrandedRuns(pool, [NS_STAGING]);

    expectAligned(sqls[0]!, paramLists[0]!);
    // $1 = the cap+1 limit, $2 = the WORKER_OFFLINE_MS heartbeat window, then
    // the namespace pair.
    expect(paramLists[0]).toEqual([21, '120000', 'acme', 'staging']);
    expect(sqls[0]).toMatch(/r\.project_id = \$3::text AND r\.env = \$4::text/);
  });

  it('prune countPrunable numbers the predicate after cutoff + statuses', async () => {
    const statuses = ['completed', 'failed', 'canceled'];
    const stmts: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        if (/WITH doomed AS/.test(sql)) {
          return { rows: [{ runs: '0', run_steps: '0', logs: '0', waits: '0', queue: '0' }] };
        }
        if (/count\(\*\) AS count FROM workers/.test(sql)) return { rows: [{ count: '0' }] };
        return { rows: [] };
      },
    } as unknown as Pool;

    await prune(pool, {
      olderThanMs: 86_400_000,
      namespaces: [NS_STAGING],
      dryRun: true,
    });

    const doomed = stmts.find((s) => /WITH doomed AS/.test(s.sql))!;
    expectAligned(doomed.sql, doomed.params);
    // $1 cutoff (PRUNABLE_RUNS, computed inside prune()), $2 statuses, then
    // the namespace pair.
    expect(doomed.params[0]).toBeInstanceOf(Date);
    expect(doomed.params.slice(1)).toEqual([statuses, 'acme', 'staging']);
    expect(doomed.sql).toMatch(/r\.project_id = \$3::text AND r\.env = \$4::text/);
  });

  it('prune deleteBatch numbers the predicate after cutoff + statuses + limit', async () => {
    const statuses = ['completed', 'failed', 'canceled'];
    const { pool, stmts } = recordPool([
      (sql) => (/SELECT r\.id FROM runs r/.test(sql) ? { rows: [] } : undefined),
    ]);

    await prune(pool, {
      olderThanMs: 86_400_000,
      namespaces: [NS_STAGING],
      batchSize: 2,
    });

    const ids = stmts.find((s) => /SELECT r\.id FROM runs r/.test(s.sql))!;
    expectAligned(ids.sql, ids.params);
    // $1 cutoff, $2 statuses, $3 batchSize (LIMIT), then the namespace pair.
    expect(ids.params[0]).toBeInstanceOf(Date);
    expect(ids.params.slice(1)).toEqual([statuses, 2, 'acme', 'staging']);
    expect(ids.sql).toMatch(/LIMIT \$3/);
    expect(ids.sql).toMatch(/r\.project_id = \$4::text AND r\.env = \$5::text/);
  });

  it('releaseClaims numbers the predicate after the worker id', async () => {
    const { pool, stmts } = recordPool([
      (sql) =>
        /SELECT run_id, project_id, env FROM queue/.test(sql)
          ? { rows: [] }
          : undefined,
    ]);

    await releaseClaims(pool, { workerId: 'w1', namespaces: [NS_STAGING] });

    const held = stmts.find((s) => /SELECT run_id, project_id, env FROM queue/.test(s.sql))!;
    expectAligned(held.sql, held.params);
    // $1 workerId (locked_by), then the namespace pair.
    expect(held.params).toEqual(['w1', 'acme', 'staging']);
    expect(held.sql).toMatch(/queue\.project_id = \$2::text AND queue\.env = \$3::text/);
  });
});

/* ---------------------------------------------------------------------------
 * SQL sweep — every business statement carries a namespace marker
 * ------------------------------------------------------------------------- */

const KERNEL_SRC = fileURLToPath(new URL('../src', import.meta.url));
const SWEEP_FILES = ['queue.ts', 'runs.ts', 'orchestrator.ts', 'workers.ts', 'prune.ts'];

/** Tables that are namespace-scoped: every statement touching them must carry
 *  project_id / env / namespaces somewhere. */
const SCOPED_TABLES = /\b(runs|queue|waits|run_steps|logs|tasks|schedules)\b/;
const SQLISH = /\b(INSERT INTO|UPDATE|DELETE FROM|SELECT|WITH)\b/;

/**
 * The PREDICATE region of a statement — where a namespace marker has to live.
 * For SELECT/UPDATE/DELETE that is everything from the first WHERE on (WHERE,
 * ON CONFLICT, RETURNING all live there); for INSERT it is the column list
 * between the table and VALUES, which must itself name the namespace columns
 * (an INSERT's own `WHERE` belongs to ON CONFLICT and is NOT where the
 * namespace is declared). A `project_id` that appears ONLY in a SELECT list (a
 * read-back of already-scoped columns) must NOT satisfy the check — that is
 * exactly the leak the sweep exists to catch (p2-28).
 */
function predicateRegion(sql: string): string {
  const insertCols = /INSERT INTO \w+\s+\((.*?)\)/s.exec(sql);
  if (insertCols) return insertCols[1]!;
  const where = sql.search(/\bWHERE\b/);
  if (where !== -1) return sql.slice(where);
  return sql;
}

/**
 * A scoped-table statement is namespace-scoped iff its PREDICATE region names
 * BOTH project_id and env (constant equalities, the `(a.project_id, a.env) IN
 * (VALUES …)` pairing, or an INSERT column list carrying both), or references
 * the workers `namespaces` jsonb column.
 */
function hasNamespaceMarker(sql: string): boolean {
  const region = predicateRegion(sql);
  return /\bproject_id\b/.test(region) && /\benv\b/.test(region) ||
    /\bnamespaces\b/.test(region);
}

/**
 * Statements that are legitimately namespace-free. Each entry is a deliberate
 * exemption, documented next to it:
 */
const ALLOWED_WITHOUT_MARKER: RegExp[] = [
  // workers is global scope (process registry): the id-keyed liveness touch,
  // the offline marker sweep and deregister all stay marker-free by design.
  /^\s*UPDATE workers\b/,
  // prune: the dependent counts and deletes run over ids that came out of an
  // already namespace-scoped SELECT (same tx), so re-predicating them would be
  // dead weight, not isolation.
  /WHERE run_id = ANY\(\$1::text\[\]\)/,
  /run_id IN \(SELECT id FROM doomed\)/,
  /DELETE FROM runs WHERE id = ANY/,
];

/**
 * A statement that interpolates the kernel's namespace predicate helper
 * (`namespacePredicate()` / `nsPredicateFor()` in queue.ts — constant
 * equalities for one namespace, the `(alias.project_id, alias.env) IN (VALUES
 * …)` pairing for two+) is scoped even though the marker text only exists at
 * runtime. Matches both the `…NsPredicate` names and the p1-08 per-namespace
 * loops' lowercase `…${predicate}` interpolation.
 */
const PREDICATE_INTERPOLATION = /\$\{[^}]*predicate\}/i;

/** Every template literal of a source file, comments stripped. */
function templateLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf('`', i);
    if (start === -1) break;
    let j = start + 1;
    let depth = 0;
    while (j < src.length) {
      const c = src[j]!;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '$' && src[j + 1] === '{') {
        depth++;
        j += 2;
        continue;
      }
      if (c === '}' && depth > 0) {
        depth--;
        j++;
        continue;
      }
      if (c === '`' && depth === 0) break;
      j++;
    }
    out.push(src.slice(start + 1, j));
    i = j + 1;
  }
  return out;
}

/** Template literals of a source file that look like SQL touching a scoped
 *  table. Comments are stripped first — several of them quote SQL in
 *  backticks and must not be read as live statements. */
function sqlStatements(file: string): string[] {
  const src = readFileSync(`${KERNEL_SRC}/${file}`, 'utf8');
  const noLineComments = src.replace(/\/\/[^\n]*/g, '');
  const noComments = noLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const literal of templateLiterals(noComments)) {
    if (!SQLISH.test(literal) || !SCOPED_TABLES.test(literal)) continue;
    out.push(literal);
  }
  return out;
}

describe('every business SQL statement is namespace-scoped (C2)', () => {
  it('finds no scoped-table statement without a namespace marker', () => {
    const offenders: { file: string; sql: string }[] = [];
    for (const file of SWEEP_FILES) {
      for (const sql of sqlStatements(file)) {
        if (hasNamespaceMarker(sql)) continue;
        if (PREDICATE_INTERPOLATION.test(sql)) continue;
        if (ALLOWED_WITHOUT_MARKER.some((re) => re.test(sql))) continue;
        offenders.push({ file, sql });
      }
    }

    // If this fails, the offender list is the gap: every statement must scope
    // on the namespace (or be provably keyed by a globally-unique id / a
    // scoped upstream selection).
    expect(offenders).toEqual([]);
  });

  it('the sweep itself is not vacuous — it sees the scoped statements', () => {
    const all = SWEEP_FILES.flatMap((f) => sqlStatements(f));
    expect(all.length).toBeGreaterThan(20);
    expect(all.some((s) => s.includes('project_id'))).toBe(true);
  });

  it('a SELECT-list-only project_id does NOT satisfy the marker (p2-28)', () => {
    // The hole the tightened marker closes: a statement that READS the
    // namespace columns but predicates on nothing namespace-scoped (the old
    // bare-substring marker let it through). predicateRegion() must cut to
    // WHERE, so this is flagged.
    const leaky = `SELECT id, run_id, project_id, env, step_seq, fingerprint
      FROM waits WHERE child_run_id = $1 AND kind = 'run' AND status = 'pending'`;
    expect(hasNamespaceMarker(leaky)).toBe(false);

    // And a genuinely scoped statement still passes.
    const scoped = `SELECT id, run_id FROM waits
      WHERE child_run_id = $1 AND status = 'pending'
        AND project_id = $2 AND env = $3`;
    expect(hasNamespaceMarker(scoped)).toBe(true);
    // The VALUES pairing form also passes.
    expect(
      hasNamespaceMarker(
        `SELECT id FROM runs WHERE (r.project_id, r.env) IN (VALUES ($1::text, $2::text))`,
      ),
    ).toBe(true);
    // An INSERT column list naming both columns passes.
    expect(
      hasNamespaceMarker(
        `INSERT INTO runs (id, project_id, env, status) VALUES ($1, $2, $3, $4)`,
      ),
    ).toBe(true);
  });
});
