/* =============================================================================
   @better-trigger/example-basic — shared-database schema isolation e2e
   (plans/database-schema-isolation, task 04-T3).

   The daemon-side counterpart of embedded.ts: one real Postgres database
   shared by a HOST project and better-trigger, exercised through the daemon
   entry (spawned worker + HTTP surface + prune CLI). Proven here:

     1. the host owns same-name tables for all nine better-trigger tables in
        `public` (plus a `host_app.tasks` shadow) and its own
        `drizzle.__drizzle_migrations` with a sentinel row NEWER than the
        better-trigger baseline;
     2. the daemon boots with a host-schema-first search_path
        (`host_app, public`) baked into its connection string and performs the
        FIRST install itself (`--migrate`): every object lands in
        `better_trigger`, `public` gains nothing, and the host journal keeps
        its exact structure and rows;
     3. unqualified host queries hit the HOST tables before boot, during
        execution and after stop; host structure and sentinel data compare
        byte-identical across the whole run; `SHOW search_path` never changes;
     4. real task execution (trigger → steps → waiter-resolved result) writes
        rows into `better_trigger` only; dashboard /tasks (with 24h stats),
        /runs/:id, /workers and /metrics all answer from the target schema —
        the metrics probe pool is a separate connection that never depends on
        the business pool's session;
     5. the real prune CLI deletes seeded history from `better_trigger` and
        leaves every host sentinel row alone.

   Env:
     DATABASE_URL              base connection derived from it; default
                               postgres://localhost:5432/better_trigger
     BT_SCHEMA_ISOLATION_DB    override the database name prefix (default
                               better_trigger_schema_iso)
     BT_SCHEMA_ISOLATION_PORT  override the daemon's port (default: free)
   ============================================================================= */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool } from '@better-trigger/db';
import {
  freePort,
  runScenario,
  startDaemon,
  waitForTasks,
  type Scenario,
} from '@better-trigger/testing';
import { betterTrigger } from 'better-trigger';

/** apps/worker's entry, run from source — same resolution as spawnDaemon. */
const WORKER_ENTRY =
  process.env.BT_WORKER_ENTRY ??
  fileURLToPath(new URL('../../../apps/worker/src/main.ts', import.meta.url));
const TASKS_MODULE = fileURLToPath(new URL('../src/tasks.ts', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../packages/db/migrations', import.meta.url),
);

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

const PORT =
  process.env.BT_SCHEMA_ISOLATION_PORT !== undefined
    ? Number(process.env.BT_SCHEMA_ISOLATION_PORT)
    : await freePort();

/** Connection string whose sessions resolve unqualified names host-first. */
function hostFirstUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', '-csearch_path=host_app,public');
  return parsed.toString();
}

/** Newest `when` of the shipped baseline journal, for the host sentinel row. */
function baselineWhen(): number {
  const journal = JSON.parse(
    readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, 'utf8'),
  ) as { entries: Array<{ when: number }> };
  return Math.max(...journal.entries.map((e) => e.when));
}

/** The host side of the database — structure AND data — as one comparable
 *  string. Read through the scenario pool with explicit qualification so the
 *  snapshot itself never depends on any search_path. */
async function hostSnapshot(s: Scenario): Promise<string> {
  const structure = await s.pool.query(
    `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema IN ('public', 'host_app', 'drizzle')
      ORDER BY table_schema, table_name, ordinal_position`,
  );
  const relations = await s.pool.query(
    `SELECT n.nspname, c.relname, c.relkind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'host_app', 'drizzle')
        AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      ORDER BY n.nspname, c.relname`,
  );
  const data: Record<string, unknown> = {};
  for (const name of SHARED_NAMES) {
    data[`public.${name}`] = (
      await s.pool.query(`SELECT id, note FROM public."${name}" ORDER BY id`)
    ).rows;
  }
  data['host_app.tasks'] = (await s.pool.query(`SELECT id, note FROM host_app.tasks ORDER BY id`)).rows;
  data['journal'] = (
    await s.pool.query(`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`)
  ).rows;
  return JSON.stringify({ structure: structure.rows, relations: relations.rows, data });
}

async function main(s: Scenario): Promise<void> {
  /* -- host side first: same-name tables, shadow, and a newer host journal -- */
  await s.pool.query(`CREATE SCHEMA host_app`);
  await s.pool.query(`CREATE SCHEMA drizzle`);
  for (const name of SHARED_NAMES) {
    await s.pool.query(`CREATE TABLE public."${name}" (id text PRIMARY KEY, note text NOT NULL)`);
    await s.pool.query(`INSERT INTO public."${name}" (id, note) VALUES ('host-sentinel', 'keep me')`);
  }
  await s.pool.query(`CREATE TABLE host_app.tasks (id text PRIMARY KEY, note text NOT NULL)`);
  await s.pool.query(`INSERT INTO host_app.tasks (id, note) VALUES ('host-app-shadow', 'first in path')`);
  await s.pool.query(
    `CREATE TABLE drizzle.__drizzle_migrations (
       "id" serial PRIMARY KEY,
       "hash" text NOT NULL,
       "created_at" bigint
     )`,
  );
  await s.pool.query(
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
    ['host-sentinel-migration-hash', baselineWhen() + 86_400_000],
  );

  const hostUrl = hostFirstUrl(s.db.url);
  // A host-mode connection: exactly how the host application talks to this
  // database (unqualified names, host-schema-first search_path).
  const hostPool = createPool(hostUrl, { error: () => {} });
  s.cleanup(() => hostPool.end());

  await s.check('before boot, unqualified host queries resolve host-first', async () => {
    const path = await hostPool.query<{ search_path: string }>('SHOW search_path');
    s.assertEqual(path.rows[0]?.search_path, 'host_app,public', 'search_path before boot');
    const tasks = await hostPool.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
    s.assertEqual(tasks.rows.map((r) => r.id), ['host-app-shadow'], 'unqualified tasks hits host_app');
    // An unqualified host WRITE lands in the host table.
    await hostPool.query(`INSERT INTO runs (id, note) VALUES ('host-write-before', 'host wrote this')`);
    const runs = await hostPool.query<{ id: string }>('SELECT id FROM runs ORDER BY id');
    s.assertEqual(runs.rows.map((r) => r.id), ['host-sentinel', 'host-write-before'], 'unqualified runs is the host table');
  });

  const hostBefore = await hostSnapshot(s);

  /* -- the daemon performs the first install itself, host-first ------------- */
  const daemon = await startDaemon({
    databaseUrl: hostUrl,
    tasks: TASKS_MODULE,
    port: PORT,
    concurrency: 2,
    migrate: true,
    name: 'schema-iso',
  });
  s.cleanup(() => daemon.stop());
  await waitForTasks(s.pool, ['hello-world', 'order-pipeline']);

  await s.check('the daemon install lands in better_trigger only', async () => {
    const tables = await s.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'better_trigger' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    s.assertEqual(
      tables.rows.map((r) => r.table_name),
      [...SHARED_NAMES, '__drizzle_migrations'].sort(),
      'better_trigger holds the nine business tables and the journal',
    );
    const journal = await s.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM better_trigger.__drizzle_migrations`,
    );
    s.assertEqual(journal.rows[0]?.n, 1, 'dedicated journal holds the single baseline row');
    // public holds EXACTLY the nine host tables — no better-trigger object,
    // no sequence, leaked into the host namespace.
    const publicRelations = await s.pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
        ORDER BY c.relname`,
    );
    s.assertEqual(publicRelations.rows.map((r) => r.relname), [...SHARED_NAMES].sort(), 'public relations');
    s.assertEqual(await hostSnapshot(s), hostBefore, 'host structure + journal + data unchanged by the install');
  });

  /* -- real execution through the daemon, host queries mid-flight ----------- */
  const client = betterTrigger({ url: daemon.url! });

  await s.check('tasks execute into better_trigger while host queries stay host-side', async () => {
    const hello = await client.trigger('hello-world', { name: 'iso' });
    // During execution, on a host connection: resolution and data unchanged.
    const path = await hostPool.query<{ search_path: string }>('SHOW search_path');
    s.assertEqual(path.rows[0]?.search_path, 'host_app,public', 'search_path during execution');
    const hostTasks = await hostPool.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
    s.assertEqual(hostTasks.rows.map((r) => r.id), ['host-app-shadow'], 'unqualified tasks during execution');

    const helloResult = await client.waitForResult(hello.id, undefined, { timeoutMs: 30_000 });
    s.assertEqual(helloResult.status, 'completed', 'hello-world status (waiter-resolved)');
    s.assertEqual(helloResult.output, 'hi iso', 'hello-world output');

    const pipeline = await client.trigger('order-pipeline', {
      customer: 'iso',
      items: [{ sku: 'book', qty: 2 }],
    });
    const pipelineResult = await client.waitForResult(pipeline.id, undefined, { timeoutMs: 30_000 });
    s.assertEqual(pipelineResult.status, 'completed', 'order-pipeline status');

    // Both runs live in better_trigger; the host runs table never saw them.
    const btRuns = await s.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM better_trigger.runs WHERE id = ANY($1::text[]) ORDER BY id`,
      [[hello.id, pipeline.id].sort()],
    );
    s.assertEqual(
      btRuns.rows.map((r) => `${r.id}:${r.status}`).sort(),
      [`${hello.id}:completed`, `${pipeline.id}:completed`].sort(),
      'both runs completed inside better_trigger',
    );
    const hostRuns = await hostPool.query<{ id: string }>('SELECT id FROM runs ORDER BY id');
    s.assertEqual(
      hostRuns.rows.map((r) => r.id),
      ['host-sentinel', 'host-write-before'],
      'the host runs table only holds host rows',
    );
  });

  await s.check('dashboard, stats and run detail serve the target schema', async () => {
    const tasks = await fetch(`${daemon.url}/api/v1/tasks`);
    s.assertEqual(tasks.status, 200, 'GET /tasks status');
    const tasksBody = (await tasks.json()) as {
      tasks: Array<{ id: string; runs24h: number; lastRunAt: string | null }>;
    };
    const hello = tasksBody.tasks.find((t) => t.id === 'hello-world');
    s.assert(hello !== undefined, 'hello-world is listed');
    s.assertEqual(hello!.runs24h, 1, 'stats counted the better_trigger run');
    s.assert(hello!.lastRunAt !== null, 'lastRunAt set from the target schema');
    const shadow = tasksBody.tasks.find((t) => t.id === 'host-app-shadow' || t.id === 'host-sentinel');
    s.assertEqual(shadow, undefined, 'no host row leaks into the dashboard');

    const workers = await fetch(`${daemon.url}/api/v1/workers`);
    s.assertEqual(workers.status, 200, 'GET /workers status');
    const schedules = await fetch(`${daemon.url}/api/v1/schedules`);
    s.assertEqual(schedules.status, 200, 'GET /schedules status');
  });

  await s.check('metrics answers from an independent probe pool', async () => {
    const res = await fetch(`${daemon.url}/api/v1/metrics`);
    s.assertEqual(res.status, 200, 'GET /metrics status');
    const body = await res.text();
    s.assert(body.includes('better_trigger_db_up 1'), 'db_up 1 under host-first search_path');
    s.assert(
      /better_trigger_queue_depth\{project_id="default",env="prod",state="available"\} \d+/.test(body),
      'queue_depth gauge present (probe pool read better_trigger.queue)',
    );
    s.assert(
      /better_trigger_inflight_runs\{project_id="default",env="prod"\} \d+/.test(body),
      'inflight_runs gauge present (probe pool read better_trigger.runs)',
    );
  });

  /* -- the prune CLI on the shared database --------------------------------- */
  await s.check('prune deletes better_trigger history and no host row', async () => {
    const finished = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await s.pool.query(
      `INSERT INTO better_trigger.runs (id, task_id, status, trigger_type, finished_at, created_at, updated_at)
       VALUES ('iso-old-run', 'hello-world', 'completed', 'api', $1, now() - interval '40 days', $1)`,
      [finished],
    );
    await s.pool.query(
      `INSERT INTO better_trigger.logs (run_id, level, message) VALUES ('iso-old-run', 'info', 'old')`,
    );
    const run = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn('bun', [WORKER_ENTRY, 'prune', '--older-than', '30d', '--no-migrate'], {
        env: { ...process.env, DATABASE_URL: hostUrl },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout.on('data', (b) => (stdout += String(b)));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stdout }));
    });
    s.assertEqual(run.code, 0, 'prune exit code');
    s.assert(/deleted: 1 run\(s\)/.test(run.stdout), run.stdout);
    const gone = await s.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM better_trigger.runs WHERE id = 'iso-old-run'`,
    );
    s.assertEqual(gone.rows[0]?.n, 0, 'the old run is gone from better_trigger');
  });

  /* -- stop: the host side of the database is byte-identical ---------------- */
  await s.check('after stop the host database is exactly as it was', async () => {
    await daemon.stop();
    const path = await hostPool.query<{ search_path: string }>('SHOW search_path');
    s.assertEqual(path.rows[0]?.search_path, 'host_app,public', 'search_path after stop');
    const tasks = await hostPool.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
    s.assertEqual(tasks.rows.map((r) => r.id), ['host-app-shadow'], 'unqualified tasks after stop');
    s.assertEqual(await hostSnapshot(s), hostBefore, 'host structure + journal + data unchanged by the whole run');
    // better-trigger's own rows survived inside its schema.
    const btRuns = await s.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM better_trigger.runs WHERE id <> 'iso-old-run'`,
    );
    s.assert(btRuns.rows[0]!.n >= 2, 'better_trigger.runs keeps the executed runs');
  });
}

await runScenario(
  {
    name: 'schema-isolation',
    what: 'daemon install + execution beside same-name host tables, a newer host journal and a host-first search_path',
    // The daemon's own --migrate path is the install under test.
    db: { name: 'better_trigger_schema_iso', envVar: 'BT_SCHEMA_ISOLATION_DB', migrate: false },
  },
  main,
);
