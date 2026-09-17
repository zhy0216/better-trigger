/* =============================================================================
   @better-trigger/example-basic — embedded host acceptance.

   Proves the no-daemon deployment against a real Postgres: the runtime applies
   migrations, registers tasks, the normal TaskHandle client crosses the
   in-process Hono adapter, durable steps execute, and stop() marks the worker
   offline. No HTTP server or child process exists in this scenario.

   It does all of that the way a real host embeds better-trigger (shared-
   database contract, plans/database-schema-isolation):

     - the database already contains HOST tables with the SAME NAMES as the
       nine better-trigger tables (in `public`, plus a `host_app.tasks`
       shadow), carrying sentinel rows;
     - the runtime receives the host's own pool: `max: 1` (every kernel loop
       serializes through one connection — the first migration and the task
       execution must not deadlock on it) and a host-schema-first
       `search_path` (`host_app, public`) baked into the connection string;
     - unqualified host queries must hit the HOST tables before boot, during
       execution and after stop, `SHOW search_path` must never change, the
       host structure and sentinel data must survive untouched, and every
       better-trigger row must land in `better_trigger` only.

   Env:
     DATABASE_URL      base connection derived from it; default
                       postgres://localhost:5432/better_trigger
     BT_EMBEDDED_DB    override the database name prefix (default
                       better_trigger_embedded)
   ============================================================================= */
import { createPool } from '@better-trigger/db';
import { runScenario, type Scenario } from '@better-trigger/testing';
import { createEmbeddedRuntime } from '@better-trigger/worker/embedded';
import { helloWorld, orderPipeline } from '../src/tasks';

/** The nine better-trigger table names the host reuses for its own tables. */
const SHARED_NAMES = [
  'logs',
  'queue',
  'run_retry_operations',
  'run_steps',
  'runs',
  'schedules',
  'tasks',
  'waits',
  'workers',
];

/** Connection string whose sessions resolve unqualified names host-first. */
function hostFirstUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', '-csearch_path=host_app,public');
  return parsed.toString();
}

/** The host schema's shape + sentinel data, as one comparable string. */
async function hostSnapshot(s: Scenario): Promise<string> {
  const columns = await s.pool.query(
    `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema IN ('public', 'host_app') ORDER BY table_schema, table_name, column_name`,
  );
  const rows: string[] = [];
  for (const name of SHARED_NAMES) {
    const res = await s.pool.query(
      `SELECT id, note FROM public."${name}" ORDER BY id`,
    );
    rows.push(`${name}:${JSON.stringify(res.rows)}`);
  }
  const shadow = await s.pool.query(`SELECT id, note FROM host_app.tasks ORDER BY id`);
  rows.push(`host_app.tasks:${JSON.stringify(shadow.rows)}`);
  return JSON.stringify({ columns: columns.rows, rows });
}

await runScenario(
  {
    name: 'embedded',
    what: 'same worker runtime in-process on the host pool (max:1, host-first search_path), beside same-name host tables',
    // The host tables must exist BEFORE the runtime migrates, so no resetDb migrate.
    db: { name: 'better_trigger_embedded', envVar: 'BT_EMBEDDED_DB', migrate: false },
  },
  async (s: Scenario) => {
    /* -- host side: same-name tables + sentinel data, before any install ---- */
    await s.pool.query(`CREATE SCHEMA host_app`);
    for (const name of SHARED_NAMES) {
      await s.pool.query(
        `CREATE TABLE public."${name}" (id text PRIMARY KEY, note text NOT NULL)`,
      );
      await s.pool.query(
        `INSERT INTO public."${name}" (id, note) VALUES ('host-sentinel', 'keep me')`,
      );
    }
    // host_app shadows public for unqualified lookups: search_path precedence.
    await s.pool.query(`CREATE TABLE host_app.tasks (id text PRIMARY KEY, note text NOT NULL)`);
    await s.pool.query(`INSERT INTO host_app.tasks (id, note) VALUES ('host-app-shadow', 'first in path')`);

    const hostUrl = hostFirstUrl(s.db.url);
    // The host's own pool: ONE connection, host-schema-first search_path.
    const sharedPool = createPool(hostUrl, { error: () => {} }, { max: 1 });
    s.cleanup(() => sharedPool.end());
    const hostBefore = await hostSnapshot(s);

    await s.check('unqualified host queries resolve host-first before boot', async () => {
      const path = await sharedPool.query<{ search_path: string }>('SHOW search_path');
      s.assertEqual(path.rows[0]?.search_path, 'host_app,public', 'search_path before boot');
      const tasks = await sharedPool.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
      s.assertEqual(tasks.rows.map((r) => r.id), ['host-app-shadow'], 'unqualified tasks hits host_app');
      const runs = await sharedPool.query<{ n: number }>('SELECT count(*)::int AS n FROM runs');
      s.assertEqual(runs.rows[0]?.n, 1, 'unqualified runs hits the host table');
    });

    const runtime = await createEmbeddedRuntime({
      pool: sharedPool,
      databaseUrl: hostUrl,
      tasks: [helloWorld, orderPipeline],
      concurrency: 2,
    });
    s.cleanup(() => runtime.stop());

    await s.check('runtime migrates through the max:1 host pool and registers', async () => {
      const workers = await s.pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM better_trigger.workers WHERE id = $1`,
        [runtime.worker.workerId],
      );
      s.assertEqual(workers.rows[0]?.status, 'online', 'embedded worker status');

      const tasks = await s.pool.query<{ id: string }>('SELECT id FROM better_trigger.tasks ORDER BY id');
      s.assertEqual(
        tasks.rows.map((row) => row.id),
        ['hello-world', 'order-pipeline'],
        'registered task ids',
      );
      s.assertEqual(runtime.client.url, 'http://better-trigger.internal', 'in-process client URL');
      // The install went to better_trigger only — the host tables are untouched.
      const path = await sharedPool.query<{ search_path: string }>('SHOW search_path');
      s.assertEqual(path.rows[0]?.search_path, 'host_app,public', 'search_path after migrate');
      const hostTasks = await sharedPool.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
      s.assertEqual(hostTasks.rows.map((r) => r.id), ['host-app-shadow'], 'host tasks still shadow-first');
    });

    await s.check('TaskHandle.trigger executes while host queries keep hitting host tables', async () => {
      const handle = await helloWorld.trigger({ name: 'ada' });
      // Mid-flight, on the same single connection the runtime is using.
      const hostRuns = await sharedPool.query<{ n: number }>('SELECT count(*)::int AS n FROM runs');
      s.assertEqual(hostRuns.rows[0]?.n, 1, 'unqualified runs still host-only during execution');
      const result = await handle.result({ timeoutMs: 10_000, throwOnTimeout: true });
      s.assertEqual(result.status, 'completed', 'hello status');
      s.assertEqual(result.output, 'hi ada', 'hello output');
    });

    await s.check('durable steps use the same replay executor as daemon mode', async () => {
      const handle = await orderPipeline.trigger({
        customer: 'ada',
        items: [{ sku: 'book', qty: 2 }],
      });
      const result = await handle.result({ timeoutMs: 10_000, throwOnTimeout: true });
      s.assertEqual(result.status, 'completed', 'pipeline status');
      s.assertEqual(result.output?.itemCount, 2, 'pipeline output');

      const steps = await s.pool.query<{ seq: number; status: string }>(
        'SELECT seq, status FROM better_trigger.run_steps WHERE run_id = $1 ORDER BY seq',
        [handle.id],
      );
      s.assertEqual(steps.rows.length, 5, 'durable ledger length');
      s.assert(steps.rows.every((row) => row.status === 'completed'), 'every step must complete');
    });

    await s.check('stop drains and marks the embedded worker offline', async () => {
      await runtime.stop();
      const worker = await s.pool.query<{ status: string }>(
        'SELECT status FROM better_trigger.workers WHERE id = $1',
        [runtime.worker.workerId],
      );
      s.assertEqual(worker.rows[0]?.status, 'offline', 'worker status after stop');
    });

    await s.check('after stop the injected pool still works and the host is untouched', async () => {
      // stop() must not have closed the host-owned pool.
      const path = await sharedPool.query<{ search_path: string }>('SHOW search_path');
      s.assertEqual(path.rows[0]?.search_path, 'host_app,public', 'search_path after stop');
      s.assertEqual(await hostSnapshot(s), hostBefore, 'host structure + sentinel data unchanged');
      // Every better-trigger row lives in the target schema, none in the host's.
      const btRuns = await s.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM better_trigger.runs',
      );
      s.assertEqual(btRuns.rows[0]?.n, 2, 'better_trigger.runs holds both executions');
      const btTasks = await s.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM better_trigger.tasks',
      );
      s.assertEqual(btTasks.rows[0]?.n, 2, 'better_trigger.tasks holds both registrations');
      const hostRuns = await sharedPool.query<{ id: string }>('SELECT id FROM public.runs ORDER BY id');
      s.assertEqual(hostRuns.rows.map((r) => r.id), ['host-sentinel'], 'public.runs holds only the sentinel');
    });
  },
);
