/* =============================================================================
   @better-trigger/example-basic — worker daemon control for the acceptance
   harnesses.

   Every harness needs the same three things: start a `better-trigger-worker`
   child, wait until it is actually up, and kill it (rudely or politely). The
   daemon is run through bun so it can import TypeScript task modules directly.

   Two daemon shapes are used across the harnesses:
     - an API node (`--no-tasks`, i.e. no --tasks flag) that serves HTTP and
       runs the lease reaper — it survives the kills, so the harness's client
       keeps working while executors die;
     - executor nodes (`--tasks <module> --no-serve`) that claim and run.
   ============================================================================= */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  name?: string;
  /** Default true. */
  serve?: boolean;
  /** Default false — harnesses migrate once, up front, to avoid a race. */
  migrate?: boolean;
  /** Extra environment for the child. */
  env?: Record<string, string>;
  /** Prefix for the child's stdio, so interleaved logs stay readable. */
  label?: string;
}

export interface Daemon {
  proc: ChildProcess;
  /** Base URL, when this daemon serves HTTP. */
  url: string | null;
  /** SIGKILL and wait for the process to be gone. */
  kill(): Promise<void>;
  /** SIGTERM, then SIGKILL if it has not exited within `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function waitExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((r) => proc.once('exit', () => r()));
}

/** Spawn a daemon. Does NOT wait for readiness — see waitForHealth(). */
export function spawnDaemon(opts: DaemonOptions): Daemon {
  const serve = opts.serve ?? true;
  const args: string[] = [WORKER_ENTRY];
  if (opts.tasks) args.push('--tasks', opts.tasks);
  if (serve) args.push('--port', String(opts.port));
  else args.push('--no-serve');
  if (opts.concurrency !== undefined) args.push('--concurrency', String(opts.concurrency));
  if (opts.leaseMs !== undefined) args.push('--lease-ms', String(opts.leaseMs));
  if (opts.reaperIntervalMs !== undefined) {
    args.push('--reaper-interval-ms', String(opts.reaperIntervalMs));
  }
  if (opts.name !== undefined) args.push('--name', opts.name);
  if (!(opts.migrate ?? false)) args.push('--no-migrate');

  const proc = spawn('bun', args, {
    env: { ...process.env, ...opts.env, DATABASE_URL: opts.databaseUrl },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  proc.on('error', (err) => {
    console.error(`\n✗ failed to spawn worker daemon: ${err.message}\n`);
    process.exit(1);
  });

  return {
    proc,
    url: serve ? `http://localhost:${opts.port}` : null,
    async kill() {
      proc.kill('SIGKILL');
      await waitExit(proc);
    },
    async stop(graceMs = 10_000) {
      proc.kill('SIGTERM');
      const exited = await Promise.race([
        waitExit(proc).then(() => true),
        sleep(graceMs).then(() => false),
      ]);
      if (!exited) {
        proc.kill('SIGKILL');
        await waitExit(proc);
      }
    },
  };
}

/** Poll GET /api/v1/health until the daemon answers, or throw. */
export async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/v1/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(150);
  }
  throw new Error(`daemon at ${url} never became healthy (${lastError})`);
}

/** Spawn a daemon and wait for its HTTP surface to answer. */
export async function startDaemon(
  opts: DaemonOptions & { port: number },
): Promise<Daemon> {
  const daemon = spawnDaemon(opts);
  await waitForHealth(daemon.url!);
  return daemon;
}
