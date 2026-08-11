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
