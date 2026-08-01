/* =============================================================================
   @better-trigger/worker — daemon entry point.

     better-trigger-worker --tasks ./src/tasks.ts

   One process owns everything that touches Postgres: the queue, the
   orchestrator loops (waits / cron / lease reaper / offline markers), the
   replay executor running your tasks, and the HTTP API the SDK and the
   dashboard talk to. Applications never connect to the database.

   Without --tasks it still serves the API and keeps the bookkeeping loops
   (reaper + offline markers) alive, but claims nothing — a dashboard-only
   process. Execution requires at least one daemon started WITH tasks.

   The API binds 127.0.0.1 by default — it is unauthenticated unless
   BETTER_TRIGGER_API_KEY is set, so "local" has to mean local. --host opens
   that up, and a non-loopback host without a key refuses to start unless
   --allow-unauthenticated says the exposure is deliberate.

   Graceful shutdown on SIGINT/SIGTERM: stop claiming, drain in-flight runs,
   stop the loops, close the server, end the pool. An escaping rejection or an
   uncaught exception takes that same path and then exits non-zero.
   ============================================================================= */
import { parseDuration } from '@better-trigger/core';
import { createPool, migrate } from '@better-trigger/db';
import { createKernel, MIN_RETENTION_MS, type OrchestratorCounters } from '@better-trigger/kernel';
import { setResultResolver } from 'better-trigger/internal';
import { createApp } from './app';
import { startHttpServer } from './listen';
import { parseOriginList, setCorsOrigins } from './middleware';
import { loadTasks } from './loader';
import { describeError, formatCrashContext } from './observability';
import { startWorkerRuntime, type WorkerHandle } from './runtime';

const USAGE = `better-trigger-worker — durable task daemon

Usage:
  better-trigger-worker [options]
  better-trigger-worker prune --older-than <duration> [--dry-run]

Options:
  --tasks <path>           Module exporting task() handles. Repeatable, or
                           comma-separated. Without it the daemon serves the
                           API but executes nothing.
  --port <n>               HTTP port                    (env PORT, default 4848)
  --host <addr>            Bind address                 (env BETTER_TRIGGER_HOST, default
                           127.0.0.1 — loopback only). Use 0.0.0.0 to accept
                           connections from the network.
  --allow-unauthenticated  Permit a non-loopback --host without an API key.
                           Without it that combination refuses to start.
  --cors-origin <origin>   Extra browser origin allowed to call the API
                           (env BETTER_TRIGGER_CORS_ORIGIN). Repeatable, or
                           comma-separated. localhost / 127.0.0.1 / [::1] on any
                           port are always allowed; everything else is refused
                           unless listed here. \`*\` allows any origin.
  --concurrency <n>        Concurrent execution slots   (env BETTER_TRIGGER_CONCURRENCY, default 5)
  --name <s>               Worker name shown in the dashboard
  --lease-ms <n>           Claim lease duration         (default 60000)
  --timer-interval-ms <n>  Wait-due scan interval       (default 1000)
  --cron-interval-ms <n>   Cron scan interval           (default 1000)
  --reaper-interval-ms <n> Expired-lease reap interval  (default 10000)
  --retention <duration>   Turn ON the retention GC loop: hourly, delete
                           terminal runs (steps + logs cascade) and offline
                           worker rows older than this ("30d", "72h"). OFF by
                           default — the daemon deletes no history unless asked.
  --gc-interval-ms <n>     Retention GC interval        (default 3600000)
  --stranded-interval-ms <n>
                           Stranded-run scan interval   (default 30000). Only
                           used with --pin-code-version, which is what starts
                           that loop.
  --database-url <s>       Postgres connection string   (env DATABASE_URL)
  --no-migrate             Skip applying migrations at boot
  --no-serve               Execute tasks without serving HTTP (executor-only
                           node; another daemon serves the API)
  --pin-code-version       Claim only runs stamped with the code version this
                           process serves for that task
                           (env BETTER_TRIGGER_PIN_CODE_VERSION). Off by
                           default, where a redeployed worker takes over every
                           in-flight run whatever code wrote its step ledger.
                           On, a run whose task was edited mid-flight waits for
                           a worker that can still replay it — including
                           forever, if that build never comes back. Watch
                           better_trigger_stranded_runs; it is switched on with
                           this flag.
  -h, --help               Show this help

Env:
  DATABASE_URL             postgres://localhost:5432/better_trigger
  BETTER_TRIGGER_API_KEY   When set, the API requires \`Authorization: Bearer <key>\`
  BETTER_TRIGGER_HOST      Same as --host
  BETTER_TRIGGER_ALLOW_UNAUTHENTICATED
                           Same as --allow-unauthenticated (set to 1/true)
  BETTER_TRIGGER_CORS_ORIGIN
                           Same as --cors-origin (comma-separated)
  BETTER_TRIGGER_PIN_CODE_VERSION
                           Same as --pin-code-version (set to 1/true)
  BETTER_TRIGGER_VERSION   Code version this build reports, overriding the
                           source-derived one. Set it to a git sha or image tag
                           to stop rebuilds from churning versions — and note
                           that it applies to every task at once, so under
                           --pin-code-version one task's edit moves them all.
  BETTER_TRIGGER_BODY_LIMIT
                           Max request body in bytes (default 1048576 = 1 MiB).
                           Over it: 413 \`payload_too_large\`
  BETTER_TRIGGER_MAX_BATCH Max items in one batchTrigger (default 500). Over it:
                           400 \`bad_request\` — split the fan-out into batches
  BETTER_TRIGGER_MAX_PAYLOAD_BYTES
                           Max serialized payload per run (default 262144 =
                           256 KiB). Over it: 400 \`bad_request\` — keep large
                           objects elsewhere and pass a reference
`;

const PRUNE_USAGE = `better-trigger-worker prune — delete history past a retention window

Usage:
  better-trigger-worker prune --older-than <duration> [--dry-run]

Deletes terminal runs (completed / failed / canceled) that finished before the
window, together with their steps and logs (foreign-key cascade), and worker
rows already marked offline whose last heartbeat is older than it. Runs that
are still queued / running / waiting are never touched, at any age, and neither
are tasks or schedules.

Options:
  --older-than <duration>  Retention window: "30d", "72h", "1w". Required.
  --dry-run                Report what would be deleted and delete nothing.
  --database-url <s>       Postgres connection string   (env DATABASE_URL)
  --no-migrate             Skip applying migrations first. The cascade that
                           removes steps and logs is a constraint added by
                           migration 0007, so on a database that has not been
                           migrated this would leave them behind.
  -h, --help               Show this help
`;

interface Options {
  tasks: string[];
  port: number;
  host: string;
  allowUnauthenticated: boolean;
  corsOrigins: string[];
  concurrency: number;
  name?: string;
  leaseMs?: number;
  timerIntervalMs?: number;
  cronIntervalMs?: number;
  reaperIntervalMs?: number;
  /** Undefined = no retention GC loop at all (the default). */
  retentionMs?: number;
  gcIntervalMs?: number;
  strandedIntervalMs?: number;
  databaseUrl?: string;
  migrate: boolean;
  serve: boolean;
  /** Claim only runs whose code version this process still serves. */
  pinCodeVersion: boolean;
}

/** `better-trigger-worker prune ...` — the one-shot maintenance subcommand. */
interface PruneOptions {
  olderThanMs: number;
  dryRun: boolean;
  databaseUrl?: string;
  migrate: boolean;
}

/**
 * Binds only this machine can reach. Everything else puts the API — which is
 * unauthenticated unless BETTER_TRIGGER_API_KEY is set — on the network.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1') return true;
  // IPv4-mapped IPv6 reaches the same interface as the address it wraps.
  if (h.startsWith('::ffff:')) return isLoopback4(h.slice('::ffff:'.length));
  return isLoopback4(h);
}

/**
 * 127/8, as a real dotted quad. A prefix match on the raw string would call
 * `127.0.0.1.evil.example` loopback and skip the check below it; that host does
 * not resolve to 127/8. Leading zeros are rejected in the first octet too —
 * `027.0.0.1` is octal 23 to inet_aton, i.e. not loopback at all.
 */
function isLoopback4(h: string): boolean {
  const parts = h.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
  return parts[0] === '127';
}

/** IPv6 literals need brackets to be a URL. */
function hostForUrl(host: string): string {
  if (isLoopbackHost(host)) return 'localhost';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * `--flag` alone is true; `--flag=<v>` honours the value. Strict rather than
 * truthy on purpose: this parses flags that open the API to the network, so an
 * unrecognised value is a typo to report, not something to guess at.
 */
function boolValue(flag: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw new Error(`${flag} must be true or false, got "${raw}"`);
}

/** Env twin of boolValue, minus the throw: anything unrecognised stays off. */
function envFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function requireInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a positive number, got "${raw}"`);
  }
  return n;
}

/**
 * A retention window as a duration ("30d", "72h", "1w"). The unit suffix is
 * required — parseDuration rejects a bare "30" for a string input, which is
 * what the CLI always hands it, so `--retention 30` cannot silently mean 30
 * milliseconds. parseDuration's own message names the flag through the rethrow
 * so the CLI error says which one was wrong.
 *
 * The floor is checked here rather than only in the kernel: prune() rejects
 * anything under MIN_RETENTION_MS, but the GC loop only calls it once a tick,
 * so `--retention 30s` would otherwise start a daemon that prints its
 * "retention GC on" banner and then throws in the background every hour.
 * Failing in parseArgs turns that into an unmissable startup error.
 */
function requireDuration(flag: string, raw: string): number {
  let ms: number;
  try {
    ms = parseDuration(raw);
  } catch (err) {
    throw new Error(`${flag}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ms < MIN_RETENTION_MS) {
    throw new Error(
      `${flag} must be at least ${MIN_RETENTION_MS}ms (got "${raw}" = ${ms}ms) — ` +
        `a shorter window would delete history the engine is still using`,
    );
  }
  return ms;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    tasks: [],
    port: Number(process.env.PORT ?? 4848),
    // Loopback by default: a local runtime should not answer the subnet.
    host: process.env.BETTER_TRIGGER_HOST || '127.0.0.1',
    allowUnauthenticated: envFlag(process.env.BETTER_TRIGGER_ALLOW_UNAUTHENTICATED),
    // Beyond loopback, which the CORS allowlist always permits. Flags only:
    // BETTER_TRIGGER_CORS_ORIGIN is read by the middleware itself (an embedded
    // createApp() has no CLI), so seeding it here would list it twice.
    corsOrigins: [],
    concurrency: Number(process.env.BETTER_TRIGGER_CONCURRENCY ?? 5),
    databaseUrl: process.env.DATABASE_URL,
    migrate: true,
    serve: true,
    pinCodeVersion: envFlag(process.env.BETTER_TRIGGER_PIN_CODE_VERSION),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Both `--flag value` and `--flag=value` are accepted.
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${flag} requires a value`);
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case '--tasks': {
        const paths = value()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        opts.tasks.push(...paths);
        break;
      }
      case '--port':
        opts.port = requireInt(flag, value());
        break;
      case '--host':
        opts.host = value();
        break;
      case '--allow-unauthenticated':
        // `--allow-unauthenticated=false` has to mean false: a bool flag that
        // ignored its value would resolve every typo towards exposure.
        opts.allowUnauthenticated =
          inline === undefined ? true : boolValue(flag, inline);
        break;
      case '--cors-origin':
        opts.corsOrigins.push(...parseOriginList(value()));
        break;
      case '--concurrency':
        opts.concurrency = requireInt(flag, value());
        break;
      case '--name':
        opts.name = value();
        break;
      case '--lease-ms':
        opts.leaseMs = requireInt(flag, value());
        break;
      case '--timer-interval-ms':
        opts.timerIntervalMs = requireInt(flag, value());
        break;
      case '--cron-interval-ms':
        opts.cronIntervalMs = requireInt(flag, value());
        break;
      case '--reaper-interval-ms':
        opts.reaperIntervalMs = requireInt(flag, value());
        break;
      case '--retention':
        opts.retentionMs = requireDuration(flag, value());
        break;
      case '--gc-interval-ms':
        opts.gcIntervalMs = requireInt(flag, value());
        break;
      case '--stranded-interval-ms':
        opts.strandedIntervalMs = requireInt(flag, value());
        break;
      case '--database-url':
        opts.databaseUrl = value();
        break;
      case '--no-migrate':
        opts.migrate = false;
        break;
      case '--no-serve':
        opts.serve = false;
        break;
      case '--pin-code-version':
        // `--pin-code-version=false` has to mean false, like the other bool
        // flags: this one decides whether in-flight runs are handed to code
        // that may not match their ledger.
        opts.pinCodeVersion = inline === undefined ? true : boolValue(flag, inline);
        break;
      default:
        throw new Error(`unknown option "${flag}" (try --help)`);
    }
  }

  return opts;
}

/**
 * `prune`'s own flag set, parsed the same strict way as the daemon's: unknown
 * flags are typos to report, and `--dry-run=false` has to mean false —
 * a bool flag that ignored its value would resolve a typo towards deleting.
 */
function parsePruneArgs(argv: string[]): PruneOptions {
  let olderThanMs: number | undefined;
  const opts: Omit<PruneOptions, 'olderThanMs'> = {
    dryRun: false,
    databaseUrl: process.env.DATABASE_URL,
    migrate: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${flag} requires a value`);
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case '-h':
      case '--help':
        process.stdout.write(PRUNE_USAGE);
        process.exit(0);
        break;
      case '--older-than':
        olderThanMs = requireDuration(flag, value());
        break;
      case '--dry-run':
        opts.dryRun = inline === undefined ? true : boolValue(flag, inline);
        break;
      case '--database-url':
        opts.databaseUrl = value();
        break;
      case '--no-migrate':
        opts.migrate = false;
        break;
      default:
        throw new Error(`unknown option "${flag}" (try \`prune --help\`)`);
    }
  }

  // No default window on purpose: a `prune` that picks one for you is a command
  // that deletes an amount of history nobody chose.
  if (olderThanMs === undefined) {
    throw new Error('prune requires --older-than <duration>, e.g. --older-than 30d');
  }
  return { ...opts, olderThanMs };
}

/* =============================================================================
   Exit paths.

   Signals and crashes converge on one function, `handoff()`. main() fills the
   `daemon` record in as each piece comes up, so a fault at any point during
   boot still hands back whatever already exists — and the crash handlers can
   be installed at module load, before there is anything to hand back.

   Handing the claims back (C3, todos/01-correctness.md) rides on the `worker`
   step below: WorkerHandle.stop() releases every claim this process still
   holds and marks the workers row offline once the drain is over. It lives
   there rather than here so all four exit paths — SIGINT, SIGTERM,
   unhandledRejection, uncaughtException — inherit it through the one handoff,
   and so an embedded host that drives the runtime directly gets it too.
   ============================================================================= */

/** Pieces to hand back on the way out, in the order they are created. */
interface Daemon {
  server: { close(): void } | null;
  worker: WorkerHandle | null;
  stopOrchestrator: (() => void) | null;
  pool: { end(): Promise<void> } | null;
}
const daemon: Daemon = { server: null, worker: null, stopOrchestrator: null, pool: null };

/** One exit at a time: a second signal (or a crash mid-drain) must not restart it. */
let exiting = false;

/**
 * A fatal fault happened at some point, whoever ends up owning the exit. A
 * crash that lands *during* a signal drain has nothing left to do — `exiting`
 * is already true — but the process must not then leave with 0 as if the
 * shutdown had been clean. This is that memory.
 */
let fatal = false;

/** How long the crash path waits for the handoff before giving up on it. */
const CRASH_HANDOFF_MS = 10_000;

/**
 * The handoff runs exactly once, and everyone who asks for it awaits the same
 * attempt. Signals, crashes and a failed boot can all reach it, sometimes at
 * the same time (a crash while a SIGTERM drain is in flight, or main().catch()
 * firing while the crash handler already drains) — and a second `pool.end()`
 * throws "Called end on pool more than once", i.e. the fallback path would be
 * the thing that breaks the exit.
 */
let handoffOnce: Promise<void> | null = null;
function handoff(): Promise<void> {
  handoffOnce ??= runHandoff();
  return handoffOnce;
}

/**
 * A handoff step threw. It stays swallowed — one piece failing to hand itself
 * back must cost neither the remaining pieces their turn nor the process its
 * exit — but a `(failed)` marker in the closing line says only *that* it broke.
 * This says which step and why, which is all anyone gets: the process is gone
 * a moment later, and whatever it failed to hand back (in-flight runs, held
 * leases, open connections) is now the reaper's problem.
 *
 * console.error straight to stderr, like the crash path above it: nothing of
 * ours buffers between the failure and a `process.exit` that may be
 * milliseconds away.
 */
function handoffStepFailed(step: string, err: unknown): void {
  console.error(`[better-trigger] handoff step "${step}" failed: ${describeError(err)}`);
}

/**
 * Stop accepting new work, drain, drop the connections. Never throws: this runs
 * on the crash path too, where a failing handoff step must not swallow the exit.
 * The closing line names the steps that actually ran — proof, in the log of a
 * process that is about to be gone, that the exit went through the handoff
 * rather than straight out.
 */
async function runHandoff(): Promise<void> {
  const steps: string[] = [];
  if (daemon.server) {
    try {
      daemon.server.close();
      steps.push('server');
    } catch (err) {
      handoffStepFailed('server', err);
      steps.push('server(failed)');
    }
  }
  if (daemon.worker) {
    try {
      await daemon.worker.stop();
      steps.push('worker');
    } catch (err) {
      handoffStepFailed('worker', err);
      steps.push('worker(failed)');
    }
  }
  if (daemon.stopOrchestrator) {
    try {
      daemon.stopOrchestrator();
      steps.push('orchestrator');
    } catch (err) {
      handoffStepFailed('orchestrator', err);
      steps.push('orchestrator(failed)');
    }
  }
  if (daemon.pool) {
    try {
      await daemon.pool.end();
      steps.push('pool');
    } catch (err) {
      handoffStepFailed('pool', err);
      steps.push('pool(failed)');
    }
  }
  console.log(
    `[better-trigger] handoff complete: ${steps.length > 0 ? steps.join(' ') : 'nothing to hand back'}`,
  );
}

async function shutdown(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  console.log(`[better-trigger] ${signal} received, draining...`);
  await handoff();
  // A crash can land mid-drain: crash() reports it and steps aside so this
  // drain finishes, which leaves this the only exit left to carry the code.
  process.exit(fatal ? 1 : 0);
}

/**
 * An escaped rejection or an uncaught exception. Node's default is to print a
 * bare stack and vanish, which leaves the leases this process holds to expire
 * on their own and says nothing about what was running. Continuing to serve is
 * not an option after an uncaught exception — but the exit gets the context and
 * the handoff first.
 */
function crash(kind: string, err: unknown): void {
  // Before the early return below: whichever exit path ends up running, it has
  // to leave non-zero now.
  fatal = true;
  console.error(
    formatCrashContext(kind, daemon.worker?.workerId, daemon.worker?.inFlightRunIds() ?? []),
  );
  // The whole error, not `.message`: this is the only record of the fault.
  console.error(describeError(err));

  // Already on the way out (a signal drain, or an earlier crash): reported, and
  // the exit code is taken care of — restarting the handoff would only cut the
  // one already running short.
  if (exiting) return;
  exiting = true;

  // A wedged handoff must not turn "crashed" into "hung". The backstop stays
  // referenced on purpose: it is what guarantees an exit code here, rather than
  // the loop draining empty and the process leaving with 0.
  const backstop = setTimeout(() => {
    console.error(`[better-trigger] handoff exceeded ${CRASH_HANDOFF_MS}ms, exiting now`);
    process.exit(1);
  }, CRASH_HANDOFF_MS);
  void handoff().then(
    () => {
      clearTimeout(backstop);
      process.exit(1);
    },
    () => {
      clearTimeout(backstop);
      process.exit(1);
    },
  );
}

process.on('unhandledRejection', (reason) => crash('unhandledRejection', reason));
process.on('uncaughtException', (err) => crash('uncaughtException', err));

/**
 * `better-trigger-worker prune --older-than 30d [--dry-run]`
 * (todos/02-performance.md PF6).
 *
 * A one-shot: connect, delete, report, exit — no server, no orchestrator, no
 * task loading, nothing claimed. It goes through `daemon.pool` so the exit
 * paths already installed above close the pool for it, including when the
 * delete throws half way.
 */
async function runPrune(argv: string[]): Promise<void> {
  const opts = parsePruneArgs(argv);
  const pool = createPool(opts.databaseUrl);
  daemon.pool = pool;
  // --dry-run promises to delete nothing, and migrating is a write: 0007 cleans
  // orphaned logs/run_steps before it can add the foreign keys, so a dry run
  // against a not-yet-migrated database would delete rows and then print
  // "nothing was deleted". A dry run therefore never migrates; if the schema is
  // behind, prune's own statements fail and say so, which is the honest outcome.
  if (opts.migrate && !opts.dryRun) await migrate(pool);

  const kernel = createKernel({ pool });
  const res = await kernel.prune({ olderThanMs: opts.olderThanMs, dryRun: opts.dryRun });

  const tag = res.dryRun ? '[dry-run] would delete' : 'deleted';
  console.log(
    `[better-trigger] prune: everything terminal before ${res.cutoff.toISOString()}\n` +
      `  ${tag}: ${res.runs} run(s), ${res.runSteps} step(s), ${res.logs} log(s), ` +
      `${res.waits} wait(s), ${res.queue} queue row(s), ${res.workers} worker row(s)`,
  );
  if (res.dryRun) {
    console.log('  nothing was deleted — drop --dry-run to apply');
  }
  await handoff();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Subcommand before flag parsing: parseArgs() rejects unknown options, and a
  // bare `prune` is exactly that as far as the daemon's parser is concerned.
  if (argv[0] === 'prune') {
    await runPrune(argv.slice(1));
    return;
  }

  const opts = parseArgs(argv);
  if (!opts.serve && opts.tasks.length === 0) {
    throw new Error('--no-serve without --tasks leaves nothing to do');
  }

  // Binding beyond loopback publishes an API that can trigger any registered
  // task and read every run payload. Refuse rather than warn when nothing
  // guards it — a warning scrolls past, and the mistake is silent until it is
  // someone else's request. --allow-unauthenticated is the deliberate override.
  const exposed = opts.serve && !isLoopbackHost(opts.host);
  const unauthenticated = !process.env.BETTER_TRIGGER_API_KEY;
  if (exposed && unauthenticated && !opts.allowUnauthenticated) {
    throw new Error(
      `--host ${opts.host} exposes the API to the network but BETTER_TRIGGER_API_KEY is unset: ` +
        'anyone who can reach this port could trigger tasks and read run payloads. ' +
        'Set BETTER_TRIGGER_API_KEY, or accept the exposure with --allow-unauthenticated ' +
        '(env BETTER_TRIGGER_ALLOW_UNAUTHENTICATED=1 where no CLI flags can be added — ' +
        'a container, for instance, where the image already sets BETTER_TRIGGER_HOST=0.0.0.0).',
    );
  }

  // Import task modules before touching the database: a typo in an entry path
  // should fail immediately, not after the process has registered itself.
  const loaded = opts.tasks.length > 0 ? await loadTasks(opts.tasks) : null;

  const pool = createPool(opts.databaseUrl); // falls back to DATABASE_URL
  daemon.pool = pool;
  if (opts.migrate) await migrate(pool);

  const kernel = createKernel({ pool });

  // RunHandle.result() inside a run resolves through the kernel rather than
  // looping back over this process's own HTTP surface.
  setResultResolver({ waitForResult: (runId, o) => kernel.waitForResult(runId, o) });

  let worker: WorkerHandle | null = null;
  // Whichever orchestrator this process ends up owning — the runtime's, or the
  // bookkeeping-only one below. /metrics reads its reaper counters.
  let orchestratorCounters: OrchestratorCounters | null = null;

  if (loaded) {
    worker = await startWorkerRuntime(
      {
        kernel,
        // One sink for the whole daemon: the runtime's best-effort catches
        // (heartbeat / claim / execute) report here rather than nowhere.
        logger: console,
        orchestrator: {
          timerIntervalMs: opts.timerIntervalMs,
          cronIntervalMs: opts.cronIntervalMs,
          reaperIntervalMs: opts.reaperIntervalMs,
          // Undefined unless --retention was given → no GC loop at all.
          retentionMs: opts.retentionMs,
          gcIntervalMs: opts.gcIntervalMs,
          // Pinning is what makes a run stranded, so it is what makes the scan
          // worth running: unpinned, everything it would report gets claimed on
          // the next poll anyway.
          stranded: opts.pinCodeVersion,
          strandedIntervalMs: opts.strandedIntervalMs,
        },
      },
      {
        tasks: loaded.tasks,
        concurrency: opts.concurrency,
        name: opts.name,
        leaseMs: opts.leaseMs,
        pinCodeVersion: opts.pinCodeVersion,
      },
    );
    daemon.worker = worker;
    orchestratorCounters = worker.orchestratorCounters;
  } else {
    // No tasks: bookkeeping only. waits/cron stay off so an API-only process
    // never resumes work that nothing in it is able to execute.
    const orchestrator = kernel.startOrchestrator({
      waits: false,
      cron: false,
      reaper: true,
      workerOffline: true,
      reaperIntervalMs: opts.reaperIntervalMs,
      // Retention is bookkeeping, so an API-only daemon is a perfectly good
      // place to run it — still only when --retention asked for it.
      retentionMs: opts.retentionMs,
      gcIntervalMs: opts.gcIntervalMs,
      // Same reasoning for the stranded scan: it reports on the whole fleet's
      // queue, not on this process's claims, so the node that serves the
      // dashboard is a natural place to watch from. --pin-code-version on an
      // executes-nothing daemon means exactly that and nothing else.
      stranded: opts.pinCodeVersion,
      strandedIntervalMs: opts.strandedIntervalMs,
    });
    daemon.stopOrchestrator = () => orchestrator.stop();
    orchestratorCounters = orchestrator.counters;
  }

  let server: { close(): void } | null = null;
  if (opts.serve) {
    // Injected before the app exists: corsMiddleware is assembled at import
    // time and asks for the list on every request, but the CLI is the only
    // place that knows about --cors-origin.
    setCorsOrigins(opts.corsOrigins);
    const app = createApp({
      kernel,
      pool,
      metrics: { worker, orchestrator: orchestratorCounters },
    });
    server = startHttpServer(app, { port: opts.port, host: opts.host });
    daemon.server = server;
  }

  if (loaded && worker) {
    console.log(
      `[better-trigger] worker ${worker.workerId} running ${loaded.tasks.length} task(s): ` +
        loaded.tasks.map((t) => t.id).join(', '),
    );
  } else {
    // A deliberate shape (the API/dashboard node of a multi-daemon setup), but
    // also what someone gets by forgetting a flag — so say how to leave it.
    console.log(
      '[better-trigger] no --tasks given: serving the API only, executing nothing. ' +
        'Pass --tasks <module> to execute (the image bakes in ' +
        '/app/examples/basic/src/tasks.ts if you just want something to run).',
    );
  }
  console.log(
    server
      ? `[better-trigger] listening on http://${hostForUrl(opts.host)}:${opts.port}` +
          (isLoopbackHost(opts.host) ? '' : ` (bound to ${opts.host})`)
      : '[better-trigger] --no-serve: executor-only node, no HTTP surface',
  );
  // Deleting history is the kind of thing a process should say out loud once,
  // at the point it was switched on — not something a user discovers later by
  // noticing runs are missing.
  if (opts.retentionMs !== undefined) {
    console.log(
      `[better-trigger] retention GC on: terminal runs (with their steps and logs) ` +
        `and offline worker rows older than ${opts.retentionMs}ms are deleted periodically`,
    );
  }
  // Same reasoning as retention's banner: this one changes which runs get
  // picked up at all, so it should be a state the operator was told about
  // rather than one they infer from a queue that stopped moving.
  if (opts.pinCodeVersion) {
    console.log(
      `[better-trigger] code-version pinning on: this process claims only runs ` +
        `stamped with the version it serves for that task. Runs left on a version ` +
        `no online worker has stay queued — see better_trigger_stranded_runs.`,
    );
  }
  // Unauthenticated-by-default is the product choice, but it should be a known
  // state rather than a forgotten one — so name it, with the address it
  // actually applies to. The exposed case gets the louder warning below.
  if (server && unauthenticated && !exposed) {
    console.log(
      `[better-trigger] API is unauthenticated: anything on this machine can call it ` +
        `(bound to ${opts.host}). Set BETTER_TRIGGER_API_KEY to require a bearer token.`,
    );
  }
  if (exposed && unauthenticated) {
    console.warn(
      `[better-trigger] WARNING: --allow-unauthenticated with --host ${opts.host} — ` +
        'the API is reachable from the network with no API key; ' +
        'anyone who can reach it can trigger tasks and read run payloads',
    );
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error('[better-trigger] fatal:', err instanceof Error ? err.message : err);
  // Boot can fail after the pool, the worker or the server already exist (a
  // failed migration, a port in use), so this exits through the same handoff —
  // half a daemon still has something to hand back. If a crash handler is
  // already draining, handoff() hands back its in-flight attempt rather than
  // starting a second one.
  fatal = true;
  exiting = true;
  await handoff();
  process.exit(1);
});
