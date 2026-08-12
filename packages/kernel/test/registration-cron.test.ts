/* =============================================================================
   @better-trigger/kernel — C4: cron registration and version-update races
   (todos/01-correctness.md).

   Pinned at the SQL level against stub clients (no Postgres), like the rest of
   this suite:

     - the task upsert is guarded so a restarting OLD worker cannot roll a NEW
       worker's metadata back: the STORED version may only be displaced once no
       online worker serves it anymore, and a refused update comes back as
       rowCount 0 → warn, nothing written, and the caller is NOT the metadata
       owner (acceptance: "旧版本 worker 不能把新版本 task metadata 回写成旧
       版本"). Only the owner's registration syncs that task's schedule;
     - the schedule upsert recomputes next_run_at ONLY when pattern/timezone
       actually changed, so re-registering a due schedule keeps it due, and a
       disabled schedule's NULL stays NULL (acceptance: "worker 重启不会无故
       跳过已经 due 的 cron fire");
     - the cron due-scan still takes FOR UPDATE SKIP LOCKED inside its
       transaction — the locking structure that keeps one schedule to one run
       across daemons (acceptance: "同一 schedule 在多 daemon 下仍然最多产生
       一个 run").

   The guard's decision itself lives in PostgreSQL (WHERE clause on the
   conflict update), so the stateful fake below mirrors the documented rule
   explicitly — the SQL-shape assertions are what pin the real statement.
   ============================================================================= */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMESPACE, type Namespace, type TaskManifest } from '@better-trigger/core';
import type { KernelLogger } from '../src/kernel';
import { startOrchestrator } from '../src/orchestrator';
import { registerWorker } from '../src/workers';

interface Stmt {
  sql: string;
  params: unknown[];
}

const NS: Namespace = DEFAULT_NAMESPACE;
const task = (over: Partial<TaskManifest> & { id: string }): TaskManifest => ({ ...over });
const manifest = (codeVersion: string, cron = true): TaskManifest[] => [
  task({
    id: 'greet',
    name: 'Greeter',
    codeVersion,
    ...(cron ? { cron: { pattern: '*/5 * * * *', timezone: 'UTC' } } : {}),
  }),
  task({ id: 'plain', codeVersion }),
];

/** Placeholder/param alignment: max $N must equal param count, every $1..$N
 *  present (same helper as namespace-isolation.test.ts). */
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

/**
 * A stateful fake of the (workers, tasks, schedules) tables, single namespace.
 *
 * The guard mirrors the C4 rule in the workers.ts docstring: the STORED
 * version is displaced only when it is NULL, equals the incoming one, or is no
 * longer in `servedVersions` (the set of versions live workers serve) — the
 * same stored-version check the real SQL builds with
 * jsonb_build_object('id', tasks.id, 'codeVersion', tasks.latest_code_version).
 * Tests mutate `servedVersions` directly to stage "the new worker is still
 * online" vs "its workers are all gone".
 */
function registrationPool() {
  const stmts: Stmt[] = [];
  const warns: string[] = [];
  const logger: KernelLogger = {
    warn: (m) => warns.push(String(m)),
    error: () => {},
  };
  const servedVersions = new Set<string>();
  const stored = new Map<string, string | null>();

  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      stmts.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO workers/.test(sql)) {
        // params[4] is the tasks jsonb: [{ id, codeVersion }] — the versions
        // this worker row serves (and the guard then sees as "still served").
        for (const entry of JSON.parse(String(params[4])) as Array<{ codeVersion: string }>) {
          servedVersions.add(entry.codeVersion);
        }
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO tasks/.test(sql)) {
        const id = String(params[0]);
        const incoming = String(params[10]);
        const current = stored.get(id) ?? null;
        if (current === null || incoming === current || !servedVersions.has(current)) {
          stored.set(id, incoming);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT latest_code_version FROM tasks/.test(sql)) {
        return {
          rows: stored.has(String(params[2]))
            ? [{ latest_code_version: stored.get(String(params[2])) }]
            : [],
        };
      }
      if (/INSERT INTO schedules/.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM schedules/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool;

  return { pool, stmts, warns, logger, servedVersions, stored };
}

const register = (
  pool: Pool,
  codeVersion: string,
  logger: KernelLogger,
  tasks?: TaskManifest[],
) =>
  registerWorker(pool, {
    name: 'w',
    codeVersion,
    runtime: 'test',
    concurrency: 1,
    namespaces: [NS],
    tasks: tasks ?? manifest(codeVersion),
    logger,
  });

/* ---------------------------------------------------------------------------
 * Task metadata owner/version rule (acceptance: old worker cannot roll back)
 * ------------------------------------------------------------------------- */

describe('registerWorker — task metadata owner/version rule (C4)', () => {
  it('registers worker + tasks + schedules in one transaction, with the guard on the task upsert', async () => {
    const { pool, logger, stmts, warns } = registrationPool();

    await register(pool, 'v2', logger);

    expect(stmts[0]!.sql).toBe('BEGIN');
    expect(stmts.at(-1)!.sql).toBe('COMMIT');
    expect(stmts.some((s) => /INSERT INTO workers/.test(s.sql))).toBe(true);

    const upsert = stmts.find((s) => /INSERT INTO tasks/.test(s.sql))!;
    // The version guard: same version, or no longer served, may overwrite.
    expect(upsert.sql).toMatch(/WHERE tasks\.latest_code_version IS NULL/);
    expect(upsert.sql).toMatch(/tasks\.latest_code_version = EXCLUDED\.latest_code_version/);
    expect(upsert.sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM workers w\s+WHERE w\.status = 'online'/);
    // The stored version is protected while a live worker serves it: heartbeat
    // within the offline-marker window (orchestrator WORKER_OFFLINE_MS), in
    // this namespace, carrying this (task id, STORED version) pair. The pair
    // is built in SQL from the target row — binding the INCOMING version here
    // would match the registering worker's own row (inserted earlier in the
    // same tx, online, fresh heartbeat) and block every takeover.
    expect(upsert.sql).toMatch(/w\.last_heartbeat_at > now\(\) - INTERVAL '2 minutes'/);
    expect(upsert.sql).toMatch(/w\.namespaces @> \$12::jsonb/);
    expect(upsert.sql).toMatch(
      /w\.tasks @> jsonb_build_array\(\s*jsonb_build_object\('id', tasks\.id, 'codeVersion', tasks\.latest_code_version\)\s*\)/,
    );
    // The guard region checks only the STORED version — EXCLUDED (the incoming
    // manifest version) must not appear inside the NOT EXISTS subquery.
    const guard = upsert.sql.slice(upsert.sql.indexOf('NOT EXISTS'));
    expect(guard).not.toMatch(/EXCLUDED/);
    expectAligned(upsert.sql, upsert.params);
    expect(JSON.parse(String(upsert.params[11]))).toEqual([NS]);
    expect(upsert.params).toHaveLength(12);

    expect(warns).toEqual([]);
  });

  it('rolling deploy: a restarting OLD worker cannot roll the NEW version back (acceptance 2)', async () => {
    const { pool, logger, warns, stored } = registrationPool();
    const single = (codeVersion: string): TaskManifest[] => [
      task({ id: 'greet', codeVersion }),
    ];

    // Worker A (new build) registers first → v2 is the owner.
    await register(pool, 'v2', logger, single('v2'));
    expect(stored.get('greet')).toBe('v2');

    // Worker B (old build) restarts and re-registers the same task with v1.
    // The stored v2 is still served by A (its worker row is online) → the
    // guard refuses: rowCount 0, a warn, and NOTHING written back.
    await register(pool, 'v1', logger, single('v1'));
    expect(stored.get('greet')).toBe('v2');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('greet');
    expect(warns[0]).toContain('v1');
    expect(warns[0]).toContain('v2');
    expect(warns[0]).toContain('NOT applied');
  });

  it('names the stored version in the warn via a namespace-scoped read', async () => {
    const { pool, logger, stmts, warns } = registrationPool();
    const single = (codeVersion: string): TaskManifest[] => [
      task({ id: 'greet', codeVersion }),
    ];
    await register(pool, 'v2', logger, single('v2'));
    await register(pool, 'v1', logger, single('v1'));

    const read = stmts.find((s) => /SELECT latest_code_version FROM tasks/.test(s.sql))!;
    expect(read).toBeDefined();
    expect(read.sql).toMatch(/WHERE project_id = \$1 AND env = \$2 AND id = \$3/);
    expect(read.params).toEqual(['default', 'prod', 'greet']);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('v2');
  });

  it('takeover stays possible once the stored version is no longer served', async () => {
    const { pool, logger, warns, stored, servedVersions } = registrationPool();
    const single = (codeVersion: string): TaskManifest[] => [
      task({ id: 'greet', codeVersion }),
    ];
    await register(pool, 'v2', logger, single('v2'));
    expect(stored.get('greet')).toBe('v2');

    // The v2 workers are gone (offline marker / deregistered) → the guard
    // checks the STORED version against the live worker set: nothing serves
    // v2 anymore, so a different version may claim the metadata — this is the
    // UPGRADE path. (The registering worker's own row serves v1, so it cannot
    // mask the absence of v2 — the real SQL builds the pair from the target
    // row for exactly this reason.)
    servedVersions.delete('v2');
    await register(pool, 'v1', logger, single('v1'));

    expect(stored.get('greet')).toBe('v1');
    expect(warns).toEqual([]);
  });

  it('same-version re-registration is an idempotent refresh, never a warn', async () => {
    const { pool, logger, warns, stored } = registrationPool();

    await register(pool, 'v2', logger);
    await register(pool, 'v2', logger);

    expect(stored.get('greet')).toBe('v2');
    expect(warns).toEqual([]);
  });

  it('first registration on an empty store wins outright (stored NULL)', async () => {
    const { pool, logger, stored } = registrationPool();

    await register(pool, 'v2', logger);

    expect(stored.get('greet')).toBe('v2');
    expect(stored.get('plain')).toBe('v2');
  });
});

/* ---------------------------------------------------------------------------
 * Schedule sync (acceptance: restarting must not postpone a due cron fire)
 * ------------------------------------------------------------------------- */

describe('registerWorker — schedule sync (C4)', () => {
  it('computes next_run_at for a fresh schedule insert', async () => {
    const { pool, logger, stmts } = registrationPool();

    await register(pool, 'v1', logger);

    const upsert = stmts.find((s) => /INSERT INTO schedules/.test(s.sql))!;
    expect(upsert.sql).toMatch(/VALUES \(\$1,\$2,\$3,\$4,\$5,\$6, true, \$7, now\(\), now\(\)\)/);
    expect(upsert.params.slice(0, 6)).toEqual([
      expect.any(String), // schedule id
      'default',
      'prod',
      'greet',
      '*/5 * * * *',
      'UTC',
    ]);
    expect(upsert.params[6]).toBeInstanceOf(Date);
    expect((upsert.params[6] as Date).getTime()).toBeGreaterThan(Date.now());
    expectAligned(upsert.sql, upsert.params);
  });

  it('keeps the existing next_run_at when pattern and timezone are unchanged (acceptance 1)', async () => {
    const { pool, logger, stmts } = registrationPool();

    await register(pool, 'v1', logger);
    await register(pool, 'v1', logger);

    const upsert = stmts.filter((s) => /INSERT INTO schedules/.test(s.sql)).at(-1)!;
    // Recompute only on a real change (pattern or timezone); otherwise keep
    // schedules.next_run_at verbatim — a due schedule stays due across a
    // restart, and a disabled schedule's NULL stays NULL.
    expect(upsert.sql).toMatch(/next_run_at = CASE/);
    expect(upsert.sql).toMatch(
      /WHEN schedules\.cron_pattern IS DISTINCT FROM EXCLUDED\.cron_pattern\s+OR schedules\.cron_tz IS DISTINCT FROM EXCLUDED\.cron_tz\s+THEN EXCLUDED\.next_run_at\s+ELSE schedules\.next_run_at\s+END/,
    );
    // The old unconditional form is gone, and so is the enabled-branch that
    // refilled a disabled row's NULL next_run_at on every registration.
    expect(upsert.sql).not.toMatch(/CASE WHEN schedules\.enabled THEN EXCLUDED\.next_run_at/);
    expect(upsert.sql).not.toMatch(/schedules\.enabled/);
  });

  it('a disabled schedule keeps its NULL next_run_at across same-pattern registrations (P1)', async () => {
    const { pool, logger, stmts } = registrationPool();

    await register(pool, 'v1', logger);

    // The dashboard disables by setting enabled = false, next_run_at = NULL.
    // Re-registering with the SAME pattern must not refill it: registration
    // never transitions disabled → enabled (that is the dashboard PATCH's job,
    // and it recomputes next_run_at itself), so the CASE has no enabled
    // condition and the unchanged row keeps its NULL via the ELSE branch.
    const upsert = stmts.find((s) => /INSERT INTO schedules/.test(s.sql))!;
    expect(upsert.sql).toMatch(/ELSE schedules\.next_run_at/);
    // The conflict branch (SET + CASE) must not mention enabled at all: the
    // disabled row keeps its enabled=false and its NULL next_run_at.
    const conflict = upsert.sql.slice(upsert.sql.indexOf('ON CONFLICT'));
    expect(conflict).not.toMatch(/enabled/);
  });

  it('recomputes next_run_at when the pattern or timezone changes', async () => {
    const { pool, logger, stmts } = registrationPool();

    await register(pool, 'v1', logger, [
      task({ id: 'greet', codeVersion: 'v1', cron: { pattern: '0 9 * * *' } }),
    ]);

    // One CASE covers both pattern and timezone drift; a changed pattern
    // flows into the THEN branch (recomputed from now).
    const upsert = stmts.find((s) => /INSERT INTO schedules/.test(s.sql))!;
    expect(upsert.params[4]).toBe('0 9 * * *');
    expect(upsert.sql).toMatch(
      /WHEN schedules\.cron_pattern IS DISTINCT FROM EXCLUDED\.cron_pattern\s+OR schedules\.cron_tz IS DISTINCT FROM EXCLUDED\.cron_tz/,
    );
  });

  it('preserves the enabled flag on re-registration (user disable survives restarts)', async () => {
    const { pool, logger, stmts } = registrationPool();

    await register(pool, 'v1', logger);

    const upsert = stmts.find((s) => /INSERT INTO schedules/.test(s.sql))!;
    expect(upsert.sql).not.toMatch(/enabled = EXCLUDED\.enabled/);
  });

  it('deletes schedules for tasks that lost their cron, scoped to the namespace', async () => {
    const { pool, logger, stmts } = registrationPool();

    await register(pool, 'v1', logger, manifest('v1', false));

    const del = stmts.find((s) => /DELETE FROM schedules/.test(s.sql))!;
    expect(del.sql).toMatch(/WHERE project_id = \$1 AND env = \$2/);
    expect(del.params).toEqual(['default', 'prod', ['greet', 'plain'], ['']]);
  });

  it('a rejected (non-owner) registration never touches the schedule (P0-2)', async () => {
    const { pool, logger, warns, stmts } = registrationPool();
    const cronTask = (codeVersion: string, pattern: string): TaskManifest[] => [
      task({ id: 'greet', codeVersion, cron: { pattern, timezone: 'UTC' } }),
    ];

    // Worker A (new build) owns the task and its schedule.
    await register(pool, 'v2', logger, cronTask('v2', '*/5 * * * *'));
    const before = stmts.length;

    // Worker B (old build) restarts: its metadata update is refused (v2 still
    // served), so its manifest's DIFFERENT cron pattern must not rewrite the
    // owner's schedule — no upsert, no recompute, no delete.
    await register(pool, 'v1', logger, cronTask('v1', '0 9 * * *'));
    expect(warns).toHaveLength(1);
    const during = stmts.slice(before);
    expect(during.some((s) => /INSERT INTO schedules/.test(s.sql))).toBe(false);
    expect(during.some((s) => /DELETE FROM schedules/.test(s.sql))).toBe(false);
  });

  it('a non-owner manifest that dropped cron cannot delete the owner schedule (P0-2)', async () => {
    const { pool, logger, warns, stmts } = registrationPool();
    const cronTask = (codeVersion: string): TaskManifest[] => [
      task({ id: 'greet', codeVersion, cron: { pattern: '*/5 * * * *', timezone: 'UTC' } }),
    ];

    await register(pool, 'v2', logger, cronTask('v2'));
    const before = stmts.length;

    // Old build B no longer declares cron for the task at all. The DELETE that
    // would remove the schedule is scoped to OWNED tasks only — B is not the
    // owner, so the schedule survives for the owner's workers.
    await register(pool, 'v1', logger, [task({ id: 'greet', codeVersion: 'v1' })]);
    expect(warns).toHaveLength(1);
    const during = stmts.slice(before);
    expect(during.some((s) => /DELETE FROM schedules/.test(s.sql))).toBe(false);
  });

  it('an owner that dropped cron still deletes its schedule', async () => {
    const { pool, logger, stmts } = registrationPool();
    const cronTask = (codeVersion: string): TaskManifest[] => [
      task({ id: 'greet', codeVersion, cron: { pattern: '*/5 * * * *', timezone: 'UTC' } }),
    ];

    await register(pool, 'v2', logger, cronTask('v2'));
    const before = stmts.length;

    // Same version re-registering (owner) with cron removed → the schedule is
    // deleted as before.
    await register(pool, 'v2', logger, [task({ id: 'greet', codeVersion: 'v2' })]);
    const during = stmts.slice(before);
    expect(during.some((s) => /DELETE FROM schedules/.test(s.sql))).toBe(true);
    expect(during.some((s) => /INSERT INTO schedules/.test(s.sql))).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Cron due-scan (acceptance: one schedule → at most one run across daemons)
 * ------------------------------------------------------------------------- */

describe('scanCron — due-scan locking structure (C4)', () => {
  it('still takes FOR UPDATE SKIP LOCKED on the due-scan', async () => {
    const stmts: Stmt[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        stmts.push({ sql, params });
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => client,
      query: async () => ({ rows: [] }),
    } as unknown as Pool;
    const logger = { warn: () => {}, error: () => {} };

    const handle = startOrchestrator(pool, logger, {
      waits: false,
      reaper: false,
      workerOffline: false,
      cronIntervalMs: 20,
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!stmts.some((s) => s.sql === 'COMMIT')) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the cron tick');
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      handle.stop();
    }

    const scan = stmts.find((s) => /FROM schedules/.test(s.sql))!;
    expect(scan).toBeDefined();
    // Static proof that the due-scan's locking structure is intact: the
    // SELECT ... FOR UPDATE SKIP LOCKED inside one transaction is what
    // serializes concurrent daemons (one tick locks the due rows, the others
    // bounce off, exactly one fire per schedule). This pins the SQL shape;
    // the single-fire guarantee itself is that locked-scan transaction, not
    // anything this stub can execute.
    expect(scan.sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(scan.sql).toMatch(/enabled = true AND next_run_at IS NOT NULL AND next_run_at <= now\(\)/);
    expect(scan.sql).toMatch(/ORDER BY next_run_at ASC/);
    expect(scan.sql).toMatch(/LIMIT 50/);
    // Single namespace (the default here) → the predicate is a pair of
    // constant equalities (p1-08), not the ≥2-pair VALUES form.
    expect(scan.sql).toMatch(/schedules\.project_id = \$1::text AND schedules\.env = \$2::text/);
    expect(scan.params).toEqual(['default', 'prod']);
  });
});
