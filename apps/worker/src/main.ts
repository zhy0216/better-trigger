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

   The API binds 127.0.0.1 by default — it is unauthenticated unless at least
   one API key is configured (BETTER_TRIGGER_API_KEY and/or
   BETTER_TRIGGER_API_KEYS), so "local" has to mean local. --host opens
   that up, and a non-loopback host without a key refuses to start unless
   --allow-unauthenticated says the exposure is deliberate.

   Graceful shutdown on SIGINT/SIGTERM: stop claiming, drain in-flight runs,
   stop the loops, close the server, end the pool. An escaping rejection or an
   uncaught exception takes that same path and then exits non-zero.
   ============================================================================= */
import { fileURLToPath } from 'node:url';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import { createHealthPool, createPool, DEFAULT_DATABASE_URL, migrate } from '@better-trigger/db';
import { createKernel, type OrchestratorCounters } from '@better-trigger/kernel';
import { derivePoolConfig } from './pool-config';
import { setResultResolver, loadExecutorStorageAsync, setExecutorStorage } from 'better-trigger/internal';
import { createApp } from './app';
import { startHttpServer } from './listen';
import { configuredApiKeys, setCorsOrigins } from './middleware';
import { loadTasks } from './loader';
import { createNotifyListener, createWakeSignal, type NotifyPayload } from './notify';
import { createNotifyCounters } from './observability';
import { startWorkerRuntime, type WorkerHandle } from './runtime';
import { createWaiterRegistry } from './waiters';
import { BUILD_SHA, BUILD_VERSION } from './generated/build-info';
import { daemon, handoff, markFatal, unhandledRejections } from './shutdown';
import { parseArgs, parsePruneArgs } from './cli';

// C4: the CLI surface (parsers, helpers, help texts) moved to cli.ts, the exit
// paths to shutdown.ts. Both stay re-exported / imported here so this file
// keeps its entry-point role and anything importing these symbols from
// './main' keeps resolving.
export {
  USAGE,
  PRUNE_USAGE,
  type Options,
  type PruneOptions,
  parseArgs,
  parsePruneArgs,
  requireInt,
  requireDuration,
  parseNamespace,
  parseNamespaces,
  parseMaxSteps,
  parsePositiveIntEnv,
  boolValue,
  envFlag,
  wrapEnvLine,
  renderEnvBlock,
} from './cli';

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
  const res = await kernel.prune({
    olderThanMs: opts.olderThanMs,
    dryRun: opts.dryRun,
    namespaces: opts.namespaces,
  });

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
  // "Authenticated" means ANY configured key: the primary OR the
  // BETTER_TRIGGER_API_KEYS list (an extras-only deployment is the normal
  // post-rotation state, so it must count as guarded).
  const exposed = opts.serve && !isLoopbackHost(opts.host);
  const unauthenticated = configuredApiKeys().length === 0;
  if (exposed && unauthenticated && !opts.allowUnauthenticated) {
    throw new Error(
      `--host ${opts.host} exposes the API to the network but no API key is configured: ` +
        'anyone who can reach this port could trigger tasks and read run payloads. ' +
        'Set BETTER_TRIGGER_API_KEY (or add keys to BETTER_TRIGGER_API_KEYS), or accept ' +
        'the exposure with --allow-unauthenticated ' +
        '(env BETTER_TRIGGER_ALLOW_UNAUTHENTICATED=1 where no CLI flags can be added — ' +
        'a container, for instance, where the image already sets BETTER_TRIGGER_HOST=0.0.0.0).',
    );
  }

  // Import task modules before touching the database: a typo in an entry path
  // should fail immediately, not after the process has registered itself.
  const loaded = opts.tasks.length > 0 ? await loadTasks(opts.tasks) : null;

  // The business pool is sized to the daemon's own work: the concurrency claim
  // loops plus headroom for the orchestrator loops, heartbeat, waiter sweep and
  // HTTP slack (see derivePoolConfig). Its deadlines are what turn a saturated
  // pool or a hung query into a bounded error instead of a hang, and the
  // connect() wrapper below is what makes the saturation visible on /metrics —
  // pg-pool rejects a checkout that outlived connectionTimeoutMillis, but it
  // does NOT emit a pool-level 'error' event for that (only idle-client errors
  // do), so the counter has to ride on the checkout itself. The pool is created
  // before the runtime, so the counter lives in a standalone object the metrics
  // route reads process-wide.
  const poolCounters = { poolCheckoutTimeouts: 0 };
  const pool = createPool(opts.databaseUrl, console, derivePoolConfig(opts.concurrency, process.env));
  // Count real checkout timeouts. pg-pool surfaces a saturated checkout as
  // "timeout exceeded when trying to connect" (its connectionTimeoutMillis
  // timer) on the REJECTED promise of connect()/query() — it does NOT emit a
  // pool 'error' event for it (only idle-client errors do), so the counter
  // has to ride on the checkout/query promises. query() internally uses the
  // callback form of connect(), which is why query() must be wrapped too —
  // an API-only daemon is 100% pool.query traffic. The match is deliberately
  // narrow (both pg-pool timeout messages, no generic /timeout/i, which would
  // misfire on idle_session_timeout / idle-in-transaction / statement_timeout
  // errors that are not pool saturation).
  {
    const isCheckoutTimeout = (err: unknown): boolean => {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown }).code;
      return (
        code === 'ETIMEDOUT' ||
        /timeout exceeded when trying to connect/i.test(message) ||
        /connection terminated due to connection timeout/i.test(message)
      );
    };
    const wrapRejection = (p: Promise<unknown> | undefined): void => {
      if (p && typeof p.catch === 'function') {
        p.catch((err: unknown) => {
          if (isCheckoutTimeout(err)) poolCounters.poolCheckoutTimeouts += 1;
        });
      }
    };
    const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
    pool.connect = ((...args: unknown[]) => {
      const result = connect(...args);
      wrapRejection(result as Promise<unknown> | undefined);
      return result;
    }) as typeof pool.connect;
    const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    pool.query = ((...args: unknown[]) => {
      const result = query(...args);
      wrapRejection(result as Promise<unknown> | undefined);
      return result;
    }) as typeof pool.query;
  }
  daemon.pool = pool;
  // PF4: a small dedicated pool for the /health?deep=1 and /metrics probes.
  // It has its own max/statement_timeout/connect-timeout, so a hung or
  // repeatedly-failing probe can never hold a business-pool connection and
  // never accumulates pending queries.
  const probePool = createHealthPool(opts.databaseUrl);
  daemon.probePool = probePool;
  if (opts.migrate) await migrate(pool);

  const kernel = createKernel({ pool });

  /* ---- notification fast-path (PF2) ------------------------------------- */
  // One dedicated LISTEN connection (a plain pg.Client, never a pool checkout
  // — a released client would be idle-destroyed after 10s, silently killing
  // the LISTEN) delivers:
  //   - `work` notifications → wake the claim loops (wake hub into runtime);
  //   - `terminal` notifications → settle the waiter registry, but only for
  //     namespaces this daemon serves — foreign-namespace waiters keep
  //     polling (notifications are an optimization, never the correctness
  //     source).
  // The waiter registry replaces the per-request kernel waitForResult poll
  // (one shared 1s sweep + notifications instead of ~4 QPS per waiter); its
  // own poller is what keeps every waiter correct when the LISTEN is down.
  const notifyCounters = createNotifyCounters();
  const wake = createWakeSignal();
  const waiters = createWaiterRegistry({ pool, counters: notifyCounters });
  const notifyListener = createNotifyListener({
    connectionString: opts.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    logger: console,
    counters: notifyCounters,
    onNotify: (payload: NotifyPayload) => {
      if (payload.type === 'work') {
        notifyCounters.claimWakes += 1;
        wake.emit();
        return;
      }
      const serving = opts.namespaces.some(
        (ns) => ns.projectId === payload.projectId && ns.env === payload.env,
      );
      if (serving) void waiters.resolve(payload.runId);
    },
  });
  // Both fast-path resources stop together, before the pool: the LISTEN
  // client is an independent connection pool.end() does not close, and the
  // registry's poll timer must not keep querying after the pool is gone.
  daemon.notify = {
    stop: async () => {
      await notifyListener.stop();
      waiters.stop(); // rejects every pending /result waiter (shutdown error)
    },
  };

  // RunHandle.result() inside a run resolves through the kernel rather than
  // looping back over this process's own HTTP surface. Handles minted inside a
  // run carry their namespace (the executor's), which is what re-scopes the
  // lookup; anything without one (a handle that lost its provenance) falls back
  // to the default namespace rather than being refused. The waiter registry
  // serves it like the HTTP route, so in-process waiters share the same sweep
  // and notifications.
  // p1-16: make sure the AsyncLocalStorage the executor runs tasks under is
  // present. The lazy sync loader resolves it on bun / Node >= 22.3; plain
  // Node ESM < 22.3 needs the async fallback — do it once, up front, so every
  // run has ctx detection. (An edge runtime without node:async_hooks leaves it
  // undefined and the executor's own guard fails any run with a clear message.)
  const storageCtor = await loadExecutorStorageAsync();
  setExecutorStorage(storageCtor ? new storageCtor() : undefined);

  setResultResolver({
    waitForResult: (runId, namespace, o) =>
      waiters.register(runId, namespace ?? DEFAULT_NAMESPACE, o),
  });

  let worker: WorkerHandle | null = null;
  // Whichever orchestrator this process ends up owning — the runtime's, or the
  // bookkeeping-only one below. /metrics reads its reaper counters.
  let orchestratorCounters: OrchestratorCounters | null;

  if (loaded) {
    worker = await startWorkerRuntime(
      {
        kernel,
        // One sink for the whole daemon: the runtime's best-effort catches
        // (heartbeat / claim / execute) report here rather than nowhere.
        logger: console,
        // PF2: `work` notifications resolve the idle claim sleeps immediately.
        wake,
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
        maxSteps: opts.maxSteps,
        namespaces: opts.namespaces,
      },
    );
    daemon.worker = worker;
    orchestratorCounters = worker.orchestratorCounters;
    // The pool checkout-timeout counter stays in the standalone poolCounters
    // object the metrics route reads via `pool:` — no fold needed, so the
    // counter is live process-wide (task-serving AND API-only daemons).
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
      // Every loop is scoped to the daemon's namespaces — an API-only node
      // configured for staging never resumes prod waits or fires prod crons.
      namespaces: opts.namespaces,
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
      probePool,
      metrics: {
        worker,
        orchestrator: orchestratorCounters,
        notify: notifyCounters,
        // Process-wide business-pool checkout timeouts — visible even on an
        // API-only daemon (no worker counters exist there).
        pool: poolCounters,
        unhandledRejections,
      },
      waiters,
      // The DB gauges /metrics exports are namespace-labelled per configured
      // namespace — an operator must be able to tell default/prod's queue from
      // acme/staging's (C2).
      namespaces: opts.namespaces,
      // O3: the embedded dashboard. In the built package this module sits in
      // dist/, so ./public resolves to dist/public — the directory
      // scripts/copy-public.mjs fills with apps/web's build output. Under a
      // source checkout (bun --watch, dev) it points at src/public, which does
      // not exist, so non-API paths keep their 404 — dev runs Vite standalone.
      publicDir: fileURLToPath(new URL('./public', import.meta.url)),
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
    `[better-trigger] build ${BUILD_VERSION}${BUILD_SHA ? ` (git ${BUILD_SHA})` : ' (no git checkout)'}`,
  );
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
  // Which namespaces this daemon serves is the single most load-bearing
  // configuration line there is: it decides which runs get picked up at all,
  // so it should be a state the operator was told about, like pinning above.
  console.log(
    `[better-trigger] serving namespace(s): ` +
      opts.namespaces.map((n) => `${n.projectId}/${n.env}`).join(', '),
  );
  // Unauthenticated-by-default is the product choice, but it should be a known
  // state rather than a forgotten one — so name it, with the address it
  // actually applies to. The exposed case gets the louder warning below.
  if (server && unauthenticated && !exposed) {
    console.log(
      `[better-trigger] API is unauthenticated: anything on this machine can call it ` +
        `(bound to ${opts.host}). Set BETTER_TRIGGER_API_KEY (or BETTER_TRIGGER_API_KEYS) ` +
        `to require a bearer token.`,
    );
  }
  if (exposed && unauthenticated) {
    console.warn(
      `[better-trigger] WARNING: --allow-unauthenticated with --host ${opts.host} — ` +
        'the API is reachable from the network with no API key; ' +
        'anyone who can reach it can trigger tasks and read run payloads',
    );
  }
}

main().catch(async (err) => {
  console.error('[better-trigger] fatal:', err instanceof Error ? err.message : err);
  // Boot can fail after the pool, the worker or the server already exist (a
  // failed migration, a port in use), so this exits through the same handoff —
  // half a daemon still has something to hand back. If a crash handler is
  // already draining, handoff() hands back its in-flight attempt rather than
  // starting a second one.
  markFatal();
  await handoff();
  process.exit(1);
});
