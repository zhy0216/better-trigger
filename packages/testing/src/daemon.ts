/* =============================================================================
   @better-trigger/testing — worker daemon control.

   Every scenario needs the same three things: start a `better-trigger-worker`
   child, wait until it is actually up, and kill it (rudely or politely). The
   daemon is run through bun so it can import TypeScript task modules directly.

   Two daemon shapes are used across the scenarios:
      - an API node (no --tasks flag) that serves HTTP and runs the lease reaper —
        it survives the kills, so the scenario's client keeps working while
        executors die;
      - executor nodes (`--tasks <module> --no-serve`) that claim and run.
   ============================================================================= */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitFor } from './poll';

/** apps/worker's entry, run from source so `.ts` task modules just work. */
const WORKER_ENTRY =
  process.env.BT_WORKER_ENTRY ??
  fileURLToPath(new URL('../../../apps/worker/src/main.ts', import.meta.url));

export interface DaemonOptions {
  databaseUrl: string;
  /** Omit together with `serve: false`. */
  port?: number;
  /** Task module to load; omit for an API-only node. */
  tasks?: string;
  concurrency?: number;
  leaseMs?: number;
  reaperIntervalMs?: number;
  /** Stranded-run scan interval; only used together with `pinCodeVersion`. */
  strandedIntervalMs?: number;
  name?: string;
  /** Default true. */
  serve?: boolean;
  /** `--pin-code-version`: claim only runs whose code version this daemon
   *  serves for that task. Default false, like the flag. */
  pinCodeVersion?: boolean;
  /** Default false — scenarios migrate once, up front, to avoid a race. */
  migrate?: boolean;
  /** Extra environment for the child. */
  env?: Record<string, string>;
}

export interface Daemon {
  proc: ChildProcess;
  /** Base URL, when this daemon serves HTTP. */
  url: string | null;
  /** Signal (SIGKILL by default) and wait for the process to be gone. */
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** SIGTERM, then SIGKILL if it has not exited within `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

export function spawnDaemon(opts: DaemonOptions): Daemon {
  const serve = opts.serve ?? true;
  if (serve && opts.port === undefined) {
    throw new Error(
      'spawnDaemon: `port` is required when the daemon serves HTTP ' +
        '(pass serve: false for an executor-only node, or freePort() for an ephemeral one)',
    );
  }
  const args: string[] = [WORKER_ENTRY];
  if (opts.tasks) args.push('--tasks', opts.tasks);
  if (serve) args.push('--port', String(opts.port));
  else args.push('--no-serve');
  if (opts.concurrency !== undefined) args.push('--concurrency', String(opts.concurrency));
  if (opts.leaseMs !== undefined) args.push('--lease-ms', String(opts.leaseMs));
  if (opts.reaperIntervalMs !== undefined) {
    args.push('--reaper-interval-ms', String(opts.reaperIntervalMs));
  }
  if (opts.strandedIntervalMs !== undefined) {
    args.push('--stranded-interval-ms', String(opts.strandedIntervalMs));
  }
  if (opts.name !== undefined) args.push('--name', opts.name);
  if (opts.pinCodeVersion) args.push('--pin-code-version');
  if (!(opts.migrate ?? false)) args.push('--no-migrate');

  const proc = spawn('bun', args, {
    env: { ...process.env, ...opts.env, DATABASE_URL: opts.databaseUrl },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  // A failed spawn (ENOENT, EACCES) fires 'error' and may never fire 'exit' —
  // surface it to whoever waits on the process instead of calling
  // process.exit() from here, which would skip the scenario's teardown
  // (see the design note in scenario.ts).
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    proc.once('error', (err) => {
      reject(new Error(`failed to spawn worker daemon: ${err.message}`, { cause: err }));
    });
  });
  // Keep the rejection "handled" even when nobody is mid-await; every waiter
  // below still receives it.
  void spawnFailure.catch(() => {});
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once('exit', () => resolve());
  });
  const waitExit = (): Promise<void> => Promise.race([exited, spawnFailure]);

  return {
    proc,
    url: serve ? `http://localhost:${opts.port}` : null,
    async kill(signal: NodeJS.Signals = 'SIGKILL') {
      proc.kill(signal);
      await waitExit();
    },
    async stop(graceMs = 10_000) {
      proc.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let exitedFirst: boolean;
      try {
        exitedFirst = await Promise.race([
          waitExit().then(() => true),
          new Promise<false>((r) => {
            timer = setTimeout(() => r(false), graceMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!exitedFirst) {
        proc.kill('SIGKILL');
        await waitExit();
      }
    },
  };
}

/**
 * Poll GET /api/v1/health until the daemon answers, or throw. Each probe is
 * bounded by the remaining deadline via AbortSignal.timeout — a daemon that
 * accepts connections but never answers cannot park the loop inside `fetch`.
 */
export async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await waitFor(
    `daemon at ${url} to become healthy`,
    timeoutMs,
    async () => {
      const remaining = Math.max(0, deadline - Date.now());
      const res = await fetch(`${url}/api/v1/health`, {
        signal: AbortSignal.timeout(remaining),
      });
      return res.ok;
    },
    { intervalMs: 150 },
  );
}

/** Spawn a daemon and wait for its HTTP surface to answer. */
export async function startDaemon(opts: DaemonOptions & { port: number }): Promise<Daemon> {
  const daemon = spawnDaemon(opts);
  try {
    await waitForHealth(daemon.url!);
  } catch (err) {
    // Nobody else owns the child yet — a daemon that never became healthy must
    // not be left running as an orphan.
    await daemon.kill().catch(() => {});
    throw err;
  }
  return daemon;
}

/**
 * Scoped daemon: start it, run `fn`, and always stop it — even when `fn`
 * throws. For scenarios that keep one daemon alive for their whole body
 * (as opposed to swapping executors under an API node).
 */
export async function withDaemon<T>(
  opts: DaemonOptions & { port: number },
  fn: (daemon: Daemon) => Promise<T>,
): Promise<T> {
  const daemon = await startDaemon(opts);
  try {
    return await fn(daemon);
  } finally {
    await daemon.stop();
  }
}

/**
 * Kill a daemon (SIGKILL by default) and wait for it to be gone — the
 * fault-injection primitive the crash scenarios are built on.
 */
export async function killDaemon(daemon: Daemon, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  await daemon.kill(signal);
}
