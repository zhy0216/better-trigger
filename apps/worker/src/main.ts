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

   Graceful shutdown on SIGINT/SIGTERM: stop claiming, drain in-flight runs,
   stop the loops, close the server, end the pool.
   ============================================================================= */
import { serve } from '@hono/node-server';
import { createPool, migrate } from '@better-trigger/db';
import { createKernel } from '@better-trigger/kernel';
import { setResultResolver } from 'better-trigger/internal';
import { createApp } from './app';
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
`;

interface Options {
  tasks: string[];
  port: number;
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
    const app = createApp({ kernel, pool });
    server = serve({ fetch: app.fetch, port: opts.port });
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
      ? `[better-trigger] listening on http://localhost:${opts.port}`
      : '[better-trigger] --no-serve: executor-only node, no HTTP surface',
  );

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
