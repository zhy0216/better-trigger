/* =============================================================================
   @better-trigger/worker — crash handling (CLI) tests.

   Node's default for an escaped rejection is to print a bare stack and vanish.
   For a daemon that holds leases that is the worst possible exit: the runs it
   was executing are invisible, and nothing in the log says why the process is
   gone. So the daemon installs unhandledRejection / uncaughtException handlers
   that report the fault WITH context, take the same handoff path as SIGINT, and
   then exit non-zero.

   Driven through the real CLI (spawned under bun) via a fixture that boots
   main.ts and then drops a fault on the floor — a unit test could only assert
   that a function exists, not that the process actually dies the right way.
   `--no-migrate` plus an unreachable DATABASE_URL is what gets the daemon fully
   up without a Postgres, exactly as host.test.ts does it.

   Three of the four cases only exist because "exits 1 with a stack on stderr"
   is also what a daemon with NO crash handling does — so each one asserts
   something the default cannot produce: the handoff actually ran (it names its
   steps), the 10s backstop actually fires (the fixture makes the handoff hang
   forever), and a crash landing mid-drain still turns the exit non-zero.

   The other half of the reported context — the in-flight run ids — is covered
   in crash-context.test.ts: a spawned daemon with no --tasks is never executing
   anything, so this file could only ever see `in-flight=none`.

   The last case is not a crash at all: a clean SIGTERM in which one handoff
   step throws. The step swallows (the exit must go through), so the line it
   prints is the entire record — it belongs here because it needs the same
   spawned daemon to prove the line survives the exit.

   Neither is the second-signal case (p1-12): a SIGTERM whose drain is wedged
   and a SIGINT on top of it. The second signal exits immediately instead of
   riding out the 45s backstop — also the sort of thing only a real process
   can prove.
   ============================================================================= */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('./fixtures/crash-entry.ts', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** An OS-assigned port, released before the CLI is handed it. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Poll a reader function until its current text matches `re`, or return false
 *  on timeout. Used to wait for a spawned daemon's own boot log line. */
async function waitForLine(read: () => string, re: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (re.test(read())) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Boots the daemon, lets the fixture fault it, and reports how it died. */
async function crashDaemon(
  mode: 'rejection' | 'exception' | 'wedge' | 'drain-race' | 'handoff-fail',
): Promise<Run> {
  const port = await freePort();
  return await new Promise<Run>((resolve, reject) => {
    const clean = { ...process.env };
    delete clean.BETTER_TRIGGER_API_KEY;
    delete clean.BETTER_TRIGGER_HOST;
    const child = spawn('bun', [ENTRY, '--port', String(port), '--no-migrate'], {
      env: {
        ...clean,
        // Nothing listens here: the daemon only needs a pool object, not a
        // reachable database, to serve /health and to hand it back on exit.
        DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent',
        BT_CRASH: mode,
        BT_CRASH_PORT: String(port),
        // p1-13: unhandledRejection is non-fatal by default (logged, daemon
        // keeps serving). These fixtures test the FATAL path, so they opt back
        // in via the gate — which also exercises the gate itself.
        ...(mode === 'rejection' || mode === 'wedge' || mode === 'drain-race'
          ? { BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION: '1' }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    // If the handlers are missing or wedge, the process outlives this and the
    // test fails on the exit code rather than hanging the suite.
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Boots the daemon (whose handoff is wedged forever), SIGTERMs it once it is
 * up, and SIGINTs it again the moment the drain is provably running — the
 * p1-12 shape: an operator who wants out NOW while the first drain is stuck.
 */
async function secondSignalDaemon(): Promise<Run> {
  const port = await freePort();
  return await new Promise<Run>((resolve, reject) => {
    const clean = { ...process.env };
    delete clean.BETTER_TRIGGER_API_KEY;
    delete clean.BETTER_TRIGGER_HOST;
    const child = spawn('bun', [ENTRY, '--port', String(port), '--no-migrate'], {
      env: {
        ...clean,
        DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent',
        BT_CRASH: 'second-signal',
        BT_CRASH_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let signalled = false;
    let interrupted = false;
    child.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!signalled && stdout.includes('listening on')) {
        signalled = true;
        child.kill('SIGTERM');
      } else if (signalled && !interrupted && stdout.includes('SIGTERM received, draining...')) {
        // Only once the drain is actually running: a second signal before the
        // first handler ran would be indistinguishable from the first.
        interrupted = true;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    // The wedged handoff would otherwise outlive the suite.
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const TIMEOUT = 40_000;

describe('crash handling', () => {
  it(
    'exits non-zero on an unhandled rejection, with the fault in stderr',
    async () => {
      const { code, stdout, stderr } = await crashDaemon('rejection');

      // The fault landed on a daemon that was up, not on one still booting.
      expect(stdout).toContain('listening on');

      expect(code).not.toBe(0);
      expect(code).toBe(1);

      expect(stderr).toContain('fatal unhandledRejection');
      // Context, not just a stack: which worker, and what it was running.
      expect(stderr).toContain('worker=');
      expect(stderr).toContain('in-flight=');
      // The whole error, stack included — this is the only record of it.
      expect(stderr).toContain('stray rejection from a background timer');
      expect(stderr).toMatch(/\n\s*at /);

      // ...and it left through the handoff, not through a bare exit. The line
      // names the steps that ran, so replacing the handoff with `process.exit(1)`
      // fails here instead of staying green.
      expect(stdout).toContain('handoff complete:');
      expect(stdout).toMatch(/handoff complete:.*\bserver\b/);
      expect(stdout).toMatch(/handoff complete:.*\bpool\b/);
    },
    TIMEOUT,
  );

  it(
    'does the same for an uncaught exception',
    async () => {
      const { code, stdout, stderr } = await crashDaemon('exception');

      expect(stdout).toContain('listening on');
      expect(code).toBe(1);
      expect(stderr).toContain('fatal uncaughtException');
      expect(stderr).toContain('in-flight=');
      expect(stderr).toContain('stray throw from a background timer');
    },
    TIMEOUT,
  );

  it(
    'does not wedge: a handoff that never finishes still exits, on the backstop',
    async () => {
      // The fixture makes pool.end() hang forever, which is the shape of every
      // real wedge here (a drain that never comes back). Without the backstop
      // the process would sit there holding its leases until something kills
      // it; with it, the exit is late but it happens, and it is non-zero.
      const started = Date.now();
      const { code, stdout, stderr } = await crashDaemon('wedge');
      const elapsed = Date.now() - started;

      expect(stdout).toContain('listening on');
      expect(code).toBe(1);
      expect(stderr).toContain('handoff exceeded 10000ms');
      // The handoff never completed — this exit came from the timer.
      expect(stdout).not.toContain('handoff complete:');
      // Bounded by the 10s backstop, not by the test runner's patience.
      expect(elapsed).toBeLessThan(20_000);
    },
    TIMEOUT,
  );

  it(
    'still exits non-zero when the fault lands during a signal drain',
    async () => {
      // SIGTERM starts draining, the rejection arrives while it runs. The crash
      // handler cannot own this exit — restarting the handoff would cut the one
      // in progress short — so the signal path has to carry the code out. Before
      // this was tracked, such a process left with 0: a daemon that died on a
      // fatal fault, reported as a clean shutdown to whatever supervises it.
      const { code, stdout, stderr } = await crashDaemon('drain-race');

      expect(stdout).toContain('SIGTERM received, draining...');
      expect(stderr).toContain('fatal unhandledRejection');
      expect(stderr).toContain('stray rejection during the drain');
      expect(code).toBe(1);
      // One handoff, not two racing ones (the second pool.end() would throw).
      expect(stdout.match(/handoff complete:/g)).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'exits immediately on a second signal instead of waiting out the drain',
    async () => {
      // The first SIGTERM's handoff is wedged (pool.end() never returns), so
      // the drain is still running when the second signal lands. Without p1-12
      // the process would sit there until the 45s backstop; with it, the second
      // signal means the operator wants out NOW and cuts the drain short.
      const started = Date.now();
      const { code, stdout } = await secondSignalDaemon();
      const elapsed = Date.now() - started;

      expect(code).toBe(1);
      expect(stdout).toContain('SIGTERM received, draining...');
      expect(stdout).toContain('shutdown was already in progress, exiting immediately');
      // The backstop never fired — this exit came from the second signal.
      expect(stdout).not.toContain('shutdown exceeded');
      // Immediate, not SHUTDOWN_BACKSTOP_MS (45s).
      expect(elapsed).toBeLessThan(15_000);
    },
    TIMEOUT,
  );
});

describe('a handoff step that fails', () => {
  it(
    'names the step and the reason on the way out, and still exits cleanly',
    async () => {
      // The steps swallow on purpose — one piece failing to hand itself back
      // must not cost the others their turn, nor the process its exit. What
      // they must not do is fail silently: this is the last log line the
      // process ever writes, and without it a shutdown that left connections
      // (or leases) behind looks exactly like one that did not.
      const { code, stdout, stderr } = await crashDaemon('handoff-fail');

      expect(stdout).toContain('listening on');
      // Nothing was fatal here — a failed handoff step is not a crash.
      expect(code).toBe(0);

      // Which step, and why. Printed before the exit, not lost with it.
      expect(stderr).toContain('handoff step "pool" failed');
      expect(stderr).toContain('pool end blew up');
      // ...and the closing line still ran, with the step marked.
      expect(stdout).toMatch(/handoff complete:.*pool\(failed\)/);
      expect(stdout).toMatch(/handoff complete:.*\bserver\b/);
    },
    TIMEOUT,
  );
});

describe('an unhandled rejection that is not fatal (p1-13)', () => {
  it(
    'keeps serving, counts it on /metrics, and exits 0 on the next SIGTERM',
    async () => {
      // No BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION: the default is to log the
      // stray rejection (usually a non-awaited promise in task code) and keep
      // the daemon — and every unrelated in-flight run — alive.
      const port = await freePort();
      const clean = { ...process.env };
      delete clean.BETTER_TRIGGER_API_KEY;
      delete clean.BETTER_TRIGGER_HOST;
      const child = spawn('bun', [ENTRY, '--port', String(port), '--no-migrate'], {
        env: {
          ...clean,
          DATABASE_URL: 'postgres://127.0.0.1:1/better_trigger_absent',
          BT_CRASH: 'stray-rejection',
          BT_CRASH_PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
      try {
        // Wait for the daemon's own "listening on" line (a fetch to a port that
        // has not bound yet can be refused-and-cached by the client), then the
        // fixture fires the rejection and the daemon must survive it.
        const booted = await waitForLine(
          () => stdout,
          /listening on/,
          20_000,
        );
        expect(booted).toBe(true);
        // Give the rejection handler a beat to run, then prove it survived it.
        await new Promise((r) => setTimeout(r, 1_500));
        expect(child.exitCode).toBeNull(); // still alive — the rejection was not fatal
        expect(stderr).toContain('unhandledRejection');
        expect(stderr).toMatch(/usually a promise in task code that was never awaited/);
        // ...and it must NOT claim the daemon is going down (the non-fatal
        // context line says "keeps serving", never "fatal … exiting").
        expect(stderr).not.toContain('fatal unhandledRejection');
        expect(stderr).not.toMatch(/exiting\./);
        // The run context is still useful: which worker was up when it landed.
        expect(stderr).toContain('worker=');

        // It is counted, so a rising better_trigger_unhandled_rejections_total
        // points at task hygiene without a silent death.
        const metrics = await (await fetch(`http://127.0.0.1:${port}/api/v1/metrics`)).text();
        expect(metrics).toMatch(/better_trigger_unhandled_rejections_total 1/);

        // The daemon is still healthy and shuts down cleanly afterwards.
        expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok).toBe(true);
        child.kill('SIGTERM');
        const code = await new Promise<number | null>((resolve) => {
          child.on('close', (c) => resolve(c));
        });
        expect(code).toBe(0);
        expect(stdout).toContain('handoff complete:');
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
    TIMEOUT,
  );
});
