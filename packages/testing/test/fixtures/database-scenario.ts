// Two copies of this exact scenario run in separate Bun processes. The parent
// releases the first while the second holds a live connection and transaction.
import { runScenario } from '../../src/scenario';

await runScenario(
  { name: 'database-isolation-probe', db: { name: process.argv[2]! } },
  async (s) => {
    const client = await s.pool.connect();
    s.cleanup(() => client.release());
    const identity = await client.query('SELECT current_database() AS name, pg_backend_pid() AS pid');
    s.assertEqual(identity.rows[0].name, s.db.name, 'SQL and returned database name agree');
    await client.query('BEGIN');
    await client.query('CREATE TABLE probe_owner (pid integer NOT NULL)');
    await client.query('INSERT INTO probe_owner VALUES ($1)', [process.pid]);
    const release = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('parent did not release probe')), 15_000);
      process.stdin.once('data', () => {
        clearTimeout(timeout);
        process.stdin.pause();
        resolve();
      });
    });
    console.log(`READY ${s.db.name}`);
    await release;
    const marker = await client.query('SELECT pid, pg_backend_pid() AS backend FROM probe_owner');
    s.assertEqual(marker.rows[0].pid, process.pid, 'only this process wrote its database');
    s.assertEqual(marker.rows[0].backend, identity.rows[0].pid, 'the original connection survived');
    await client.query('COMMIT');
    s.ok('isolated transaction and connection survived peer cleanup');
  },
);
