/* =============================================================================
   Fixture for crash.test.ts: the real daemon, plus one fault.

   Importing main.ts boots the CLI exactly as `better-trigger-worker` does
   (argv is passed through by the spawn), so the crash handlers under test are
   the real ones. The fault is only fired once /api/v1/health answers — the
   point of the test is what happens to a daemon that is already *up*, not to
   one that fell over during boot.

   BT_CRASH=rejection  a promise nobody awaits           (unhandledRejection)
   BT_CRASH=exception  a throw from a timer callback     (uncaughtException)
   BT_CRASH=wedge      a rejection, on a daemon whose handoff can never finish
   BT_CRASH=drain-race SIGTERM first, then a rejection while the drain runs
   BT_CRASH=handoff-fail  a clean SIGTERM whose `pool.end()` rejects
   BT_CRASH=second-signal  a clean SIGTERM whose drain can never finish — the
                      test drives a second signal on top of it (p1-12)

   The last three are built by patching `pool.end()` — the last step of the
   handoff, so a pool that ends slowly (or never) is a handoff still running
   when the fault lands, and a pool that ends by throwing is a handoff step
   that fails. Patched on pg's prototype before main.ts is imported and creates
   its pool: the daemon under test keeps its real code path, and there is no
   test-only branch inside it.
   ============================================================================= */
import pg from 'pg';

const port = process.env.BT_CRASH_PORT;
const mode = process.env.BT_CRASH ?? 'rejection';

/** Never resolves: the handoff can only end on the crash backstop. */
if (mode === 'wedge') {
  pg.Pool.prototype.end = () => new Promise<void>(() => {});
}
/** Same wedge, but no fault of its own: the p1-12 test SIGTERMs this daemon
 *  (whose drain then hangs on the never-ending pool.end) and SIGINTs it again,
 *  so the second signal has a real drain to cut short. */
if (mode === 'second-signal') {
  pg.Pool.prototype.end = () => new Promise<void>(() => {});
}
/** Slow enough that the rejection below lands mid-drain, fast enough that the
 *  backstop is not what ends the test. */
if (mode === 'drain-race') {
  pg.Pool.prototype.end = () => new Promise<void>((resolve) => setTimeout(resolve, 2_000));
}
/** A handoff step that fails on an otherwise clean exit: nothing else in the
 *  process is wrong, so whatever the catch prints is the only trace there is. */
if (mode === 'handoff-fail') {
  pg.Pool.prototype.end = () => Promise.reject(new Error('pool end blew up'));
}

// Dynamic, so the patch above lands first: a static import is hoisted, and the
// daemon would already hold its pool by the time the fixture ran a line.
await import('../../src/main');

async function waitUntilUp(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('daemon never came up');
}

void waitUntilUp().then(() => {
  if (mode === 'second-signal') {
    // The test drives the signals; this daemon only exists to be shut down.
    return;
  }
  if (mode === 'handoff-fail') {
    // No fault at all — just a shutdown in which one step cannot do its job.
    process.kill(process.pid, 'SIGTERM');
    return;
  }
  if (mode === 'drain-race') {
    // A clean shutdown that is already draining when a fatal fault arrives.
    // The signal handler owns the exit at that point, so it is the one that has
    // to notice the crash and refuse to leave with 0.
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => {
      void Promise.reject(new Error('stray rejection during the drain'));
    }, 200);
    return;
  }
  if (mode === 'exception') {
    setTimeout(() => {
      throw new Error('stray throw from a background timer');
    }, 0);
    return;
  }
  // Deliberately not awaited and not .catch()ed: this is the escaping
  // rejection the handler has to turn into a diagnosed exit.
  void Promise.reject(new Error('stray rejection from a background timer'));
});
