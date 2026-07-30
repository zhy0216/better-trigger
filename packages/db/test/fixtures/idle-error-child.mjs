/* =============================================================================
   Child process for pool.test.ts — the real proof that an idle-client error no
   longer takes the daemon down. The error is emitted from a timer, i.e. from a
   stack no caller can wrap in try/catch, which is exactly how pg surfaces it.
   Plain .mjs importing the .ts source: Node strips the types, so the child runs
   the same code the daemon does without needing a build step first.
   ============================================================================= */
import { createPool } from '../../src/pool.ts';

// Port 1 is never listened on: the pool is created but nothing ever connects,
// so the only 'error' that reaches it is the one emitted below.
const pool = createPool('postgres://better_trigger@127.0.0.1:1/none');

setTimeout(() => {
  // pg's own signature: (err, client). Without the listener createPool
  // installs, Node rethrows this as an uncaught exception → exit code 1.
  pool.emit('error', new Error('boom'), null);
}, 0);

setTimeout(async () => {
  await pool.end();
  console.log('SURVIVED');
}, 50);
