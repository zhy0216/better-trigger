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
   stop the loops, close the server, end the pool.
   ============================================================================= */
import { createPool, migrate } from '@better-trigger/db';
import { createKernel } from '@better-trigger/kernel';
import { setResultResolver } from 'better-trigger/internal';
import { createApp } from './app';
import { startHttpServer } from './listen';
import { parseOriginList, setCorsOrigins } from './middleware';
import { loadTasks } from './loader';
import { startWorkerRuntime, type WorkerHandle } from './runtime';

const USAGE = `better-trigger-worker — durable task daemon

Usage:
  better-trigger-worker [options]

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
  --database-url <s>       Postgres connection string   (env DATABASE_URL)
  --no-migrate             Skip applying migrations at boot
  --no-serve               Execute tasks without serving HTTP (executor-only
                           node; another daemon serves the API)
  -h, --help               Show this help

Env:
  DATABASE_URL             postgres://localhost:5432/better_trigger
  BETTER_TRIGGER_API_KEY   When set, the API requires \`Authorization: Bearer <key>\`
  BETTER_TRIGGER_HOST      Same as --host
  BETTER_TRIGGER_ALLOW_UNAUTHENTICATED
                           Same as --allow-unauthenticated (set to 1/true)
  BETTER_TRIGGER_CORS_ORIGIN
                           Same as --cors-origin (comma-separated)
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
  databaseUrl?: string;
  migrate: boolean;
  serve: boolean;
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
      case '--database-url':
        opts.databaseUrl = value();
        break;
      case '--no-migrate':
        opts.migrate = false;
        break;
      case '--no-serve':
        opts.serve = false;
        break;
      default:
        throw new Error(`unknown option "${flag}" (try --help)`);
    }
  }

  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
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
  if (opts.migrate) await migrate(pool);

  const kernel = createKernel({ pool });

  // RunHandle.result() inside a run resolves through the kernel rather than
  // looping back over this process's own HTTP surface.
  setResultResolver({ waitForResult: (runId, o) => kernel.waitForResult(runId, o) });

  let worker: WorkerHandle | null = null;
  let stopOrchestrator: (() => void) | null = null;

  if (loaded) {
    worker = await startWorkerRuntime(
      {
        kernel,
        orchestrator: {
          timerIntervalMs: opts.timerIntervalMs,
          cronIntervalMs: opts.cronIntervalMs,
          reaperIntervalMs: opts.reaperIntervalMs,
        },
      },
      {
        tasks: loaded.tasks,
        concurrency: opts.concurrency,
        name: opts.name,
        leaseMs: opts.leaseMs,
      },
    );
  } else {
    // No tasks: bookkeeping only. waits/cron stay off so an API-only process
    // never resumes work that nothing in it is able to execute.
    const orchestrator = kernel.startOrchestrator({
      waits: false,
      cron: false,
      reaper: true,
      workerOffline: true,
      reaperIntervalMs: opts.reaperIntervalMs,
    });
    stopOrchestrator = () => orchestrator.stop();
  }

  let server: { close(): void } | null = null;
  if (opts.serve) {
    // Injected before the app exists: corsMiddleware is assembled at import
    // time and asks for the list on every request, but the CLI is the only
    // place that knows about --cors-origin.
    setCorsOrigins(opts.corsOrigins);
    const app = createApp({ kernel, pool });
    server = startHttpServer(app, { port: opts.port, host: opts.host });
  }

  if (loaded && worker) {
    console.log(
      `[better-trigger] worker ${worker.workerId} running ${loaded.tasks.length} task(s): ` +
        loaded.tasks.map((t) => t.id).join(', '),
    );
  } else {
    console.log(
      '[better-trigger] no --tasks given: serving the API only, executing nothing',
    );
  }
  console.log(
    server
      ? `[better-trigger] listening on http://${hostForUrl(opts.host)}:${opts.port}` +
          (isLoopbackHost(opts.host) ? '' : ` (bound to ${opts.host})`)
      : '[better-trigger] --no-serve: executor-only node, no HTTP surface',
  );
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

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[better-trigger] ${signal} received, draining...`);
    // Stop accepting new work first, then drain, then drop the connections.
    server?.close();
    await worker?.stop();
    stopOrchestrator?.();
    await pool.end().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[better-trigger] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
