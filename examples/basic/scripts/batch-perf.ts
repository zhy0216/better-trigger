/* =============================================================================
   @better-trigger/example-basic — batchTrigger round-trip acceptance (PF5,
   todos/02-performance.md).

   The unit tests prove the statement-count invariant against a stub; this
   scenario proves it against a REAL Postgres, with the idempotency index and
   all. The kernel's pool is wrapped so every data statement (BEGIN/COMMIT/
   ROLLBACK excluded) is counted: a 500-item batch must cost the SAME small
   number of statements as a 100-item batch — task preload + runs INSERT +
   queue INSERT + one notify — where the pre-PF5 path cost ~3 statements per
   item. The same run of the scenario then pins the semantics that must NOT
   have changed: idempotency conflicts re-read in one batched statement
   (3 statements, nothing enqueued), a mixed batch returns every run id in
   input order, the total-payload cap refuses with 400 before any SQL, an
   unknown task fails the whole batch atomically, and the resulting 500 queue
   rows are genuinely claimable.

   Runs on @better-trigger/testing: runScenario provisions + migrates the
   scenario's database and folds the verdict into the exit code. No daemon, no
   HTTP — kernel-level, like fencing.ts. Registered in scripts/acceptance.ts
   (part of `bun run test:acceptance`).

   Env:
     DATABASE_URL        base connection derived from it; default
                         postgres://localhost:5432/better_trigger
     BT_BATCH_PERF_DB    override the provisioned database name (default
                         better_trigger_batch_perf)
   ============================================================================= */
import { DEFAULT_NAMESPACE, KernelError, type TriggerItem } from '@better-trigger/core';
import { createKernel } from '@better-trigger/kernel';
import { runScenario, type Scenario } from '@better-trigger/testing';

/* pg types come through the kernel/testing packages, not a direct import (the
   documented boundary: only apps/worker, packages/kernel and the harness
   import pg — the scenarios never do). */
type KernelPool = Parameters<typeof createKernel>[0]['pool'];

/**
 * Wrap a pool so every data statement issued through it is counted (tx
 * bookkeeping excluded). The kernel gets the wrapper; the assertions read the
 * real pool directly.
 */
function makeCountingPool(pool: KernelPool): { pool: KernelPool; dataStatements: () => number } {
  let n = 0;
  const patched = new WeakSet<object>();
  const wrapped = {
    ...pool,
    connect: async () => {
      const client = await pool.connect();
      // Patch each client at most once: the pool reuses the same client
      // object across checkouts, and stacking a patch per checkout would
      // count every statement once per layer.
      if (!patched.has(client)) {
        patched.add(client);
        const original = client.query.bind(client);
        // Forward every argument (including pg's internal callback form — a
        // dropped callback would make pool.query hang forever) and count only
        // data statements.
        client.query = ((text: string, ...rest: unknown[]) => {
          if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) n += 1;
          return (original as unknown as (t: string, ...r: unknown[]) => unknown)(text, ...rest);
        }) as typeof client.query;
      }
      return client;
    },
  };
  return { pool: wrapped as KernelPool, dataStatements: () => n };
}

const ns = DEFAULT_NAMESPACE;
const makeItems = (n: number, key?: (i: number) => string | undefined): TriggerItem[] =>
  Array.from({ length: n }, (_, i) => ({
    taskId: 't1',
    payload: { n: i },
    options: key ? { idempotencyKey: key(i) ?? undefined } : undefined,
  }));

async function countRuns(s: Scenario): Promise<number> {
  return (await s.pool.query(`SELECT count(*)::int AS n FROM runs`)).rows[0].n;
}

async function main(s: Scenario): Promise<void> {
  // Synthetic fan-out data — nothing a post-mortem would want.
  s.cleanup(() => s.db.drop());
  await s.pool.query(
    `INSERT INTO tasks (id, name, trigger_source) VALUES ('t1', 'batch t1', 'api')`,
  );
  const counting = makeCountingPool(s.pool);
  const kernel = createKernel({ pool: counting.pool });

  const big = makeItems(500, (i) => `k-${i}`);
  const small = makeItems(100, (i) => `s-${i}`);

  await s.check('a 500-item batch lands 500 runs and 500 queue rows in exactly 4 statements', async () => {
    const before = counting.dataStatements();
    const res = await kernel.batchTrigger(big, ns);
    const used = counting.dataStatements() - before;

    s.assertEqual(res.runIds.length, 500, '500 runIds returned');
    s.assertEqual(await countRuns(s), 500, '500 runs rows');
    s.assertEqual(
      (await s.pool.query(`SELECT count(*)::int AS n FROM queue`)).rows[0].n,
      500,
      '500 queue rows',
    );
    // 4 = task preload + runs INSERT + queue INSERT + the aggregate notify.
    s.assert(
      used === 4,
      `expected exactly 4 data statements for 500 items, got ${used} — ` +
        `the batch is round-tripping per item again`,
    );
    s.log(`500-item batch: ${used} data statements`);
  });

  await s.check('a 100-item batch costs the SAME statement count — exactly 4, no growth with item count', async () => {
    const before = counting.dataStatements();
    await kernel.batchTrigger(small, ns);
    const used = counting.dataStatements() - before;
    s.assert(
      used === 4,
      `expected exactly 4 data statements for 100 items, got ${used}`,
    );
    s.log(`100-item batch: ${used} data statements`);
  });

  await s.check('an idempotent re-trigger re-reads the existing runs in ONE statement and enqueues nothing', async () => {
    const before = counting.dataStatements();
    const again = await kernel.batchTrigger(big, ns);
    const used = counting.dataStatements() - before;

    s.assertEqual(again.runIds.length, 500, '500 runIds on the replay');
    // 3 = preload + runs INSERT (all conflicts) + the batched readback. No
    // queue INSERT (nothing new), no notify (no new work).
    s.assert(
      used === 3,
      `expected exactly 3 data statements for a fully-conflicted 500-item batch, got ${used}`,
    );
    s.assertEqual(
      (await s.pool.query(`SELECT count(*)::int AS n FROM queue`)).rows[0].n,
      600,
      'queue still has exactly the 500 + 100 rows created so far',
    );
    s.assertEqual(await countRuns(s), 600, 'no duplicate runs');
    s.log(`fully-conflicted 500-item batch: ${used} data statements (batched readback)`);
  });

  await s.check('a mixed batch returns every run id in input order', async () => {
    const first = await kernel.batchTrigger(big, ns);
    const mixed = makeItems(500, (i) => (i % 2 === 0 ? `k-${i}` : undefined));
    const res = await kernel.batchTrigger(mixed, ns);

    s.assertEqual(res.runIds.length, 500, '500 runIds');
    // 500 (big) + 100 (small) + 250 fresh mixed = 850 — the 250 even items conflicted.
    s.assertEqual(await countRuns(s), 850, 'the even items conflicted — no duplicate rows');
    for (let i = 0; i < 500; i++) {
      if (i % 2 === 0) {
        s.assert(
          res.runIds[i] === first.runIds[i],
          `conflicted item ${i} must resolve to the first batch's id ${first.runIds[i]}, got ${res.runIds[i]}`,
        );
      } else {
        s.assert(
          !first.runIds.includes(res.runIds[i]!),
          `fresh item ${i} must get a new id, got the first batch's ${res.runIds[i]}`,
        );
      }
    }
  });

  await s.check('a batch over the total payload cap is refused with 400 and costs zero statements', async () => {
    const beforeRuns = await countRuns(s);
    const before = counting.dataStatements();
    // 500 × 3 KiB = 1.5 MiB > the 1 MiB batch cap — every item is fine on its
    // own, only the batch-level cap can refuse it.
    let code: string | null = null;
    try {
      await kernel.batchTrigger(makeItems(500, (i) => `cap-${i}`).map((it) => ({
        ...it,
        payload: { blob: 'x'.repeat(3 * 1024) },
      })), ns);
    } catch (err) {
      code = err instanceof KernelError ? err.code : String(err);
    }
    s.assertEqual(code, 'bad_request', 'refused with bad_request (400)');
    const used = counting.dataStatements() - before;
    s.assert(
      used === 0,
      `expected ZERO statements for an over-cap batch, got ${used} — the refusal must happen before the tx`,
    );
    s.assertEqual(await countRuns(s), beforeRuns, 'nothing inserted');
  });

  await s.check('an unknown task fails the whole batch atomically', async () => {
    const before = await countRuns(s);
    let code: string | null = null;
    try {
      await kernel.batchTrigger(
        [
          ...makeItems(499, (i) => `atom-${i}`),
          { taskId: 'ghost-task', payload: null },
        ],
        ns,
      );
    } catch (err) {
      code = err instanceof KernelError ? err.code : String(err);
    }
    s.assertEqual(code, 'task_not_found', 'refused with task_not_found');
    // All-or-nothing: the 499 valid items of the batch must not exist.
    s.assertEqual(await countRuns(s), before, 'no partial insert');
    s.assertEqual(
      (await s.pool.query(`SELECT count(*)::int AS n FROM queue`)).rows[0].n,
      850,
      'queue untouched',
    );
  });

  await s.check('a failure DURING the batch INSERT rolls the whole transaction back', async () => {
    const beforeRuns = await countRuns(s);
    const beforeQueue = (await s.pool.query(`SELECT count(*)::int AS n FROM queue`)).rows[0].n;
    // The NUL byte passes every kernel pre-check (a non-empty string) but
    // PostgreSQL refuses it at INSERT time ("null character not permitted") —
    // so the multi-row runs INSERT fails mid-batch, after the preload and
    // after the valid first item's row was written into the statement. The tx
    // must roll back: no runs, no queue rows.
    let threw: string | null = null;
    try {
      await kernel.batchTrigger(
        [
          { taskId: 't1', payload: { ok: true }, options: { idempotencyKey: 'good-key' } },
          {
            taskId: 't1',
            payload: { ok: true },
            options: { idempotencyKey: 'bad\u0000key' },
          },
        ],
        ns,
      );
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    s.assert(threw !== null, 'the NUL-byte item must be refused by the database');
    s.assertEqual(await countRuns(s), beforeRuns, 'no run survives the rollback');
    s.assertEqual(
      (await s.pool.query(`SELECT count(*)::int AS n FROM queue`)).rows[0].n,
      beforeQueue,
      'no queue row survives the rollback',
    );
    s.log(`mid-INSERT failure rolled back cleanly: ${threw}`);
  });

  await s.check('an empty batch is a no-op: empty result, nothing inserted', async () => {
    const beforeRuns = await countRuns(s);
    const res = await kernel.batchTrigger([], ns);
    s.assertEqual(res.runIds.length, 0, 'empty runIds');
    s.assertEqual(await countRuns(s), beforeRuns, 'no rows created');
  });

  await s.check('the 500 queued runs are genuinely claimable', async () => {
    const claimed = await kernel.claimRuns({
      workerId: 'batch-perf-worker',
      namespaces: [ns],
      taskIds: ['t1'],
      limit: 10,
      leaseMs: 60_000,
    });
    s.assertEqual(claimed.length, 10, 'claimed 10 of the 500');
  });

  s.ok('batchTrigger PF5 acceptance: O(1) statements, all-or-nothing, byte cap, claimable rows');
}

await runScenario(
  {
    name: 'batch-perf',
    what: 'a 500-item batchTrigger is O(1) statements on a real Postgres; semantics unchanged (PF5)',
    db: { name: 'better_trigger_batch_perf', envVar: 'BT_BATCH_PERF_DB' },
  },
  main,
);
