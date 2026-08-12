/* =============================================================================
   @better-trigger/kernel — true-Postgres test helpers (todos/p1-22).

   The kernel's stub tests assert SQL text against a fake client; they cannot
   see planner decisions, lock ordering or the interaction of two statements
   sharing a transaction. These helpers drive the real kernel against a real
   Postgres so those invariants get asserted for the first time.

   Gating: everything here is skipped unless DATABASE_URL is set. `bun run test`
   therefore stays DB-free on a machine without Postgres, and the CI job (which
   provisions one) runs the whole directory automatically.

   Each suite provisions its own database via @better-trigger/testing's
   resetDb (DROP/CREATE + migrate), runs against it, and drops it on the way
   out — order-independent and rerunnable, same contract as the acceptance
   harnesses.
   ============================================================================= */
import { describe } from 'vitest';
import { resetDb, type TestDatabase } from '@better-trigger/testing';
import type { Pool } from 'pg';
import { createKernel, type Kernel } from '../../src/index';

export const PG_AVAILABLE = Boolean(process.env.DATABASE_URL);

/** `describe` that is cleanly skipped when DATABASE_URL is not set. */
export const describePg = PG_AVAILABLE ? describe : describe.skip;

export interface PgContext {
  /** The kernel over the provisioned database. */
  kernel: Kernel;
  /** The provisioned database (pool / url / drop). */
  db: TestDatabase;
  /** Convenience alias for `db.pool`. */
  pool: Pool;
}

/**
 * Provision a fresh migrated database for one suite, run `fn` against a kernel
 * over it, and drop the database afterwards. Databases are dropped rather than
 * merely truncated so a suite is rerunnable without manual cleanup.
 */
export async function withPg(
  name: string,
  fn: (ctx: PgContext) => Promise<void>,
): Promise<void> {
  const db = await resetDb({ name: `bt_kernel_${name}` });
  try {
    const kernel = createKernel({ pool: db.pool });
    await fn({ kernel, db, pool: db.pool });
  } finally {
    await db.drop();
  }
}

/** Recursively collect the node types of an EXPLAIN (FORMAT JSON) plan. */
export function planNodeTypes(plan: unknown, out: string[] = []): string[] {
  if (Array.isArray(plan)) {
    for (const p of plan) planNodeTypes(p, out);
    return out;
  }
  if (plan && typeof plan === 'object') {
    const rec = plan as Record<string, unknown>;
    // EXPLAIN (FORMAT JSON) wraps the whole plan in one `{ "Plan": ... }`
    // object; descend into it before walking `Plans`.
    if (rec['Plan'] && typeof rec['Plan'] === 'object') planNodeTypes(rec['Plan'], out);
    if (typeof rec['Node Type'] === 'string') out.push(rec['Node Type'] as string);
    if (Array.isArray(rec['Plans'])) planNodeTypes(rec['Plans'], out);
  }
  return out;
}

/** Assert a query's plan is an Index Scan on `table` (without ANALYZE — the
 *  plan the hot path actually lives in). Returns the plan JSON so a failure
 *  can print it. */
export async function assertIndexScan(
  pool: Pool,
  sql: string,
  params: unknown[],
  table: string,
): Promise<string> {
  const res = await pool.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  // EXPLAIN's only result column is named `QUERY PLAN` (kept verbatim by pg,
  // not folded to lower case like ordinary unquoted identifiers).
  const plan = (res.rows[0] as Record<string, unknown> | undefined)?.['QUERY PLAN'];
  const types = planNodeTypes(plan);
  if (!types.some((t) => t.startsWith('Index Scan') || t.startsWith('Index Only Scan'))) {
    throw new Error(
      `expected an Index Scan for ${table} but the planner chose: ${types.join(' → ')} ` +
        `— plan: ${JSON.stringify(plan, null, 2)}`,
    );
  }
  return JSON.stringify(plan, null, 2);
}
