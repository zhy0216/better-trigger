/* =============================================================================
   @better-trigger/db — the indexes the kernel's hot loops depend on actually
   reach a database. schema.ts is the source of truth, but nothing runs it: only
   the generated SQL in ../migrations is applied at boot, so a schema edit
   without a `bun run db:generate` is a silent sequential scan in production.
   These read the shipped .sql files (no Postgres, no drizzle-kit) and pin that
   pairing. Scans every migration, so a later one may rename or rebuild an index
   as long as the shape survives.

   The other half of the pairing — that schema.ts and the migrations still agree
   — is `bun run check:drift` (scripts/check-drift.mjs) in CI. These assertions
   deliberately cannot see schema.ts: they pin what a database actually gets.
   ============================================================================= */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Every generated migration, concatenated in application order. */
const migrationSql = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8'))
  .join('\n');

/**
 * The index's shape *after every migration has run*: the last statement naming
 * it, but only if that statement builds it.
 *
 * Taking the last CREATE alone would be a hole: a later migration that merely
 * drops the index — the exact regression these tests exist to catch, since the
 * hot loop then goes back to a sequential scan — leaves the earlier CREATE in
 * the concatenated SQL and the assertions pass on an index no database has.
 * Returns undefined once a DROP is the final word, so `toBeDefined()` fails.
 */
function shippedIndex(name: string): string | undefined {
  const statements = [
    ...migrationSql.matchAll(
      new RegExp(`(CREATE|DROP) INDEX (?:IF (?:NOT )?EXISTS )?"${name}"[^;]*`, 'g'),
    ),
  ];
  const last = statements.at(-1);
  return last?.[1] === 'CREATE' ? last[0] : undefined;
}

/** Every index name any migration ever mentions. */
const indexNames = [
  ...new Set(
    [...migrationSql.matchAll(/(?:CREATE|DROP) INDEX (?:IF (?:NOT )?EXISTS )?"([^"]+)"/g)].map(
      (m) => m[1]!,
    ),
  ),
];

/**
 * The names of the indexes a fully-migrated database has on `table` — i.e. the
 * ones whose final word is still a CREATE. Used to pin that an index shape was
 * REBUILT rather than added beside: two indexes over the same columns on the
 * fastest-growing table is write amplification with no plan to show for it.
 */
function liveIndexesOn(table: string): string[] {
  return indexNames.filter((name) => shippedIndex(name)?.includes(` ON "${table}" `));
}

describe('queue_lease_until_idx (reaper scan, PF1)', () => {
  const create = shippedIndex('queue_lease_until_idx');

  it('is created by a migration, on (project_id, env, lease_until)', () => {
    expect(create).toBeDefined();
    // Namespace prefix first (C2): the reaper scan is namespace-filtered.
    expect(create).toMatch(
      /ON "queue" USING btree \("project_id","env","lease_until"\)/,
    );
  });

  it('is partial — only claimed rows carry a lease', () => {
    // Without the predicate the index would carry one entry per queued row; the
    // reaper only ever looks at the in-flight subset. The predicate is also what
    // the reaper's own `lease_until IS NOT NULL` clause exists to match.
    expect(create).toMatch(/WHERE "queue"\."lease_until" IS NOT NULL/);
  });
});

describe('queue_claimable_idx (claim candidate scan, PF2)', () => {
  /** The shape a fresh database ends up with — a later migration may rebuild it. */
  const create = shippedIndex('queue_claimable_idx');

  it('is created by a migration, keyed exactly as the claim scan orders', () => {
    // (priority DESC, id) — the scan's ORDER BY, after the (project_id, env)
    // namespace prefix the scan filters on (C2). `NULLS FIRST` is not
    // decoration: `ORDER BY priority DESC` is NULLS FIRST, and an index built
    // the other way (drizzle's default for .desc()) cannot satisfy the sort, so
    // the plan falls back to reading every claimable row and sorting it on
    // every poll.
    expect(create).toBeDefined();
    expect(create).toMatch(
      /ON "queue" USING btree \("project_id","env","priority" DESC NULLS FIRST,"id"\)/,
    );
  });

  it('is partial — a backlog is mostly rows some worker already holds', () => {
    // The claimed rows are exactly the ones the pre-0006 plan read and discarded.
    // `available_at <= now()` is deliberately NOT in here: now() is not immutable
    // and cannot appear in an index predicate.
    expect(create).toMatch(/WHERE "queue"\."locked_by" IS NULL/);
    expect(create).not.toMatch(/available_at/);
  });
});

describe('waits_run_idx (per-run waits lookups)', () => {
  const create = shippedIndex('waits_run_idx');

  it('is created by a migration, on (project_id, env, run_id, step_seq)', () => {
    // Namespace prefix first (C2), then the run id every per-run waits query
    // filters on; the step_seq tail covers waitForChildRun's `run_id + step_seq`
    // probe. Without it terminalFail/cancelRun's cleanups, the child-wait probe,
    // and getRunDetail's waits page all scan the never-deleted waits table.
    expect(create).toBeDefined();
    expect(create).toMatch(
      /ON "waits" USING btree \("project_id","env","run_id","step_seq"\)/,
    );
  });
});

/* ---------------------------------------------------------------------------
 * FK-support indexes (0016).
 *
 * Postgres enforces a foreign key by looking up the REFERENCING column alone:
 * deleting a run checks `DELETE FROM logs WHERE run_id = $1`,
 * `UPDATE waits SET child_run_id = NULL WHERE child_run_id = $1`, and so on.
 * None of those mentions the namespace, so 0010's (project_id, env, ...) prefix
 * made every one of them a sequential scan over the referenced table — six per
 * run prune deleted. These are the indexes the cascades actually use, and the
 * assertion that matters is the one a later "just add the namespace prefix for
 * consistency" edit would break: they must lead with the FK column, NOT with
 * project_id/env.
 * ------------------------------------------------------------------------- */
describe.each([
  ['waits', 'waits_run_id_fk_idx', 'run_id'],
  ['waits', 'waits_child_run_id_fk_idx', 'child_run_id'],
  ['runs', 'runs_parent_run_id_fk_idx', 'parent_run_id'],
  ['run_retry_operations', 'run_retry_operations_source_run_id_fk_idx', 'source_run_id'],
  ['run_retry_operations', 'run_retry_operations_retry_run_id_fk_idx', 'retry_run_id'],
] as const)('%s %s (FK cascade support)', (table, name, column) => {
  const create = shippedIndex(name);

  it('is created by a migration, keyed on the referencing column alone', () => {
    expect(create).toBeDefined();
    expect(create).toMatch(new RegExp(`ON "${table}" USING btree \\("${column}"\\)$`));
  });

  it('is not namespace-prefixed — the FK check never binds those columns', () => {
    expect(create).not.toMatch(/project_id/);
    expect(create).not.toMatch(/"env"/);
  });
});

describe('logs_run_id_idx (log page + run_id cascade, one index)', () => {
  const create = shippedIndex('logs_run_id_idx');

  it('leads with run_id so the cascade and the log page share it', () => {
    // The log page filters run_id + namespace and orders by id; with the three
    // equalities bound, the id tail still serves its ORDER BY/LIMIT. The
    // cascade gets the same index for `WHERE run_id = $1`, which the old
    // namespace-led shape could not answer at all.
    expect(create).toBeDefined();
    expect(create).toMatch(/ON "logs" USING btree \("run_id","project_id","env","id"\)/);
  });

  it('is the only secondary index on logs — no duplicate (run_id) beside it', () => {
    // logs is the fastest-growing table; a second index over the same columns
    // would be write amplification on every log line for a lookup this one
    // already answers.
    expect(liveIndexesOn('logs')).toEqual(['logs_run_id_idx']);
  });
});

describe('workers_online_heartbeat_idx (online-only worker scans, 0016)', () => {
  const create = shippedIndex('workers_online_heartbeat_idx');

  it('is created by a migration, keyed on last_heartbeat_at', () => {
    // Every hot worker scan (offline marker, served-task probe, stranded scan,
    // registration's ownership check) filters status='online' plus a heartbeat
    // bound, and the table is append-only history with no other index.
    expect(create).toBeDefined();
    expect(create).toMatch(/ON "workers" USING btree \("last_heartbeat_at"\)/);
  });

  it('is partial — only the online set is ever scanned', () => {
    // The predicate is the point: it keeps the index at the live handful
    // instead of the whole (unbounded, retention-off-by-default) history.
    expect(create).toMatch(/WHERE "workers"\."status" = 'online'/);
  });
});
