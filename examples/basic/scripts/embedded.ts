/* =============================================================================
   @better-trigger/example-basic — embedded host acceptance.

   Proves the no-daemon deployment against a real Postgres: the runtime applies
   migrations, registers tasks, the normal TaskHandle client crosses the
   in-process Hono adapter, durable steps execute, and stop() marks the worker
   offline. No HTTP server or child process exists in this scenario.
   ============================================================================= */
import { runScenario, type Scenario } from '@better-trigger/testing';
import { createEmbeddedRuntime } from '@better-trigger/worker/embedded';
import { helloWorld, orderPipeline } from '../src/tasks';

await runScenario(
  {
    name: 'embedded',
    what: 'same worker runtime in the application process, with no daemon or TCP listener',
    db: { name: 'better_trigger_embedded', envVar: 'BT_EMBEDDED_DB', migrate: false },
  },
  async (s: Scenario) => {
    const runtime = await createEmbeddedRuntime({
      databaseUrl: s.db.url,
      tasks: [helloWorld, orderPipeline],
      concurrency: 2,
    });
    s.cleanup(() => runtime.stop());

    await s.check('runtime migrates the database and registers its worker/tasks', async () => {
      const workers = await s.pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM workers WHERE id = $1`,
        [runtime.worker.workerId],
      );
      s.assertEqual(workers.rows[0]?.status, 'online', 'embedded worker status');

      const tasks = await s.pool.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
      s.assertEqual(
        tasks.rows.map((row) => row.id),
        ['hello-world', 'order-pipeline'],
        'registered task ids',
      );
      s.assertEqual(runtime.client.url, 'http://better-trigger.internal', 'in-process client URL');
    });

    await s.check('TaskHandle.trigger executes through the in-process client', async () => {
      const handle = await helloWorld.trigger({ name: 'ada' });
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
        'SELECT seq, status FROM run_steps WHERE run_id = $1 ORDER BY seq',
        [handle.id],
      );
      s.assertEqual(steps.rows.length, 5, 'durable ledger length');
      s.assert(steps.rows.every((row) => row.status === 'completed'), 'every step must complete');
    });

    await s.check('stop drains and marks the embedded worker offline', async () => {
      await runtime.stop();
      const worker = await s.pool.query<{ status: string }>(
        'SELECT status FROM workers WHERE id = $1',
        [runtime.worker.workerId],
      );
      s.assertEqual(worker.rows[0]?.status, 'offline', 'worker status after stop');
    });
  },
);
