/* =============================================================================
   @better-trigger/worker — CLI surface (C4: split out of main.ts).

   Everything that turns process.argv / process.env into typed options: the
   two flat flag parsers (parseArgs for the daemon, parsePruneArgs for the
   prune subcommand), the helpers they share, and both help texts. The only
   I/O here is printing --help; boot and exit orchestration stay in main.ts /
   shutdown.ts.
   ============================================================================= */
import {
  assertNamespace,
  DEFAULT_NAMESPACE,
  parseDuration,
  type Namespace,
} from '@better-trigger/core';
import { MIN_RETENTION_MS } from '@better-trigger/kernel';
import { parseOriginList } from './middleware';
import { ENV_CATEGORY_TITLES, ENV_KNOBS } from './env-registry';

export const USAGE = `better-trigger-worker — durable task daemon

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
  --namespace <projectId>/<env>
                           A namespace this worker serves (repeatable, or
                           comma-separated; env BETTER_TRIGGER_NAMESPACES).
                           Runs, tasks, schedules and queues are isolated per
                           (projectId, env) pair: a worker registers its tasks
                           in, claims from, and resumes/crons only the
                           namespaces listed here. Default: default/prod —
                           the namespace every pre-namespace row lives in.
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

${renderEnvBlock()}
`;

/** Wrap a `name  help...` line so a terminal keeps the description aligned:
 *  the first line starts at `prefix`, continuation lines re-indent to the same
 *  column. Break at word boundaries, never mid-word. */
export function wrapEnvLine(prefix: string, text: string): string[] {
  const width = 80;
  const indent = prefix.length;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = prefix;
  for (const word of words) {
    if (line === prefix) {
      line = `${prefix} ${word}`;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = `${' '.repeat(indent)}${word}`;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * The `Env:` block of --help, rendered from ENV_KNOBS (env-registry.ts) — the
 * single source of truth for every `BETTER_TRIGGER_*` knob the worker and the
 * kernel read. Grouped by category, so --help cannot silently drift from the
 * registry; test/env-registry.test.ts guards the registry against the source.
 * DATABASE_URL / PORT stay hand-written here (they are not BETTER_TRIGGER_*).
 */
export function renderEnvBlock(): string {
  const nameWidth = Math.max(...ENV_KNOBS.map((k) => k.name.length)) + 2;
  const body: string[] = [];
  let current: string | undefined;
  for (const knob of ENV_KNOBS) {
    if (knob.category !== current) {
      current = knob.category;
      body.push('');
      body.push(`  ${ENV_CATEGORY_TITLES[current] ?? current}:`);
    }
    const prefix = `    ${knob.name.padEnd(nameWidth)}`;
    const text = `${knob.help} (default: ${knob.default})`;
    body.push(...wrapEnvLine(prefix, text));
  }
  return [
    'Env:',
    '  DATABASE_URL             postgres://localhost:5432/better_trigger',
    '  PORT                     HTTP listen port (default 4848)',
    ...body,
    '',
  ].join('\n');
}

export const PRUNE_USAGE = `better-trigger-worker prune — delete history past a retention window

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
  --namespace <projectId>/<env>
                           Namespaces to prune (repeatable, or comma-separated;
                           env BETTER_TRIGGER_NAMESPACES). A pruner only ever
                           deletes history inside these pairs — it can never
                           remove another namespace's runs. Default:
                           default/prod.
  --database-url <s>       Postgres connection string   (env DATABASE_URL)
  --no-migrate             Skip applying migrations first. The cascade that
                           removes steps and logs is a constraint added by
                           migration 0007, so on a database that has not been
                           migrated this would leave them behind.
  -h, --help               Show this help
`;

export interface Options {
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
  /** Cap on a run's replayed step ledger; 0 = unlimited. */
  maxSteps: number;
  /** Namespaces this worker serves (claim / register / orchestrator scope). */
  namespaces: Namespace[];
}

/** `better-trigger-worker prune ...` — the one-shot maintenance subcommand. */
export interface PruneOptions {
  olderThanMs: number;
  dryRun: boolean;
  /** Namespaces whose history this prune deletes (never outside them). */
  namespaces: Namespace[];
  databaseUrl?: string;
  migrate: boolean;
}

/**
 * `--flag` alone is true; `--flag=<v>` honours the value. Strict rather than
 * truthy on purpose: this parses flags that open the API to the network, so an
 * unrecognised value is a typo to report, not something to guess at.
 */
export function boolValue(flag: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw new Error(`${flag} must be true or false, got "${raw}"`);
}

/** Env twin of boolValue, minus the throw: anything unrecognised stays off. */
export function envFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function requireInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a positive number, got "${raw}"`);
  }
  return n;
}

/**
 * An integer read from the environment, positive and required. PORT and
 * BETTER_TRIGGER_CONCURRENCY both feed places where a garbage value would
 * otherwise be silent: concurrency lands in `Array.from({ length })` (NaN → 0
 * claim loops → a daemon that serves the API but never picks up a task), and
 * the port would blow up later inside listen() instead of at parse time. A
 * typo'd or fractional value therefore fails here, naming the variable.
 */
export function parsePositiveIntEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/**
 * BETTER_TRIGGER_MAX_STEPS: cap on a run's replayed step ledger. Unset → the
 * 10000 default; 0 means unlimited (the pre-p1-07 behaviour). Negative or
 * unparseable is a startup error on purpose — a typo'd cap must not silently
 * become unlimited, and a typo'd cap that stays at the default would go
 * unnoticed until a run fails for a reason nobody configured.
 */
export function parseMaxSteps(raw: string | undefined): number {
  if (raw === undefined) return 10000;
  const n = Number(raw);
  // Integer, not just numeric: a fractional cap would flow into the claim's
  // `LIMIT $4` param as "10000.5" and explode at the database (bigint parse
  // error) on the first over-cap claim instead of failing at startup.
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`BETTER_TRIGGER_MAX_STEPS must be a non-negative integer, got "${raw}"`);
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
export function requireDuration(flag: string, raw: string): number {
  let ms: number;
  try {
    ms = parseDuration(raw);
  } catch (err) {
    throw new Error(`${flag}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (ms < MIN_RETENTION_MS) {
    throw new Error(
      `${flag} must be at least ${MIN_RETENTION_MS}ms (got "${raw}" = ${ms}ms) — ` +
        `a shorter window would delete history the engine is still using`,
    );
  }
  return ms;
}

/**
 * One `<projectId>/<env>` namespace spec from the CLI. The '/' is required —
 * `--namespace acme` is a typo, not an env of 'acme'. assertNamespace then
 * rejects empty / over-long / ':'-bearing parts, and the rethrow names the
 * flag, so the startup error says which configuration was wrong.
 */
export function parseNamespace(flag: string, raw: string): Namespace {
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(`${flag} must be "<projectId>/<env>", got "${raw}"`);
  }
  const ns: Namespace = { projectId: raw.slice(0, slash), env: raw.slice(slash + 1) };
  try {
    assertNamespace(ns);
  } catch (err) {
    throw new Error(`${flag} "${raw}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return ns;
}

/**
 * Namespace specs out of one flag value / env var — comma-separated like
 * --tasks — validated and deduped. registerWorker upserts per namespace, so a
 * duplicate would be harmless but would churn the workers row's namespaces
 * array for nothing.
 */
export function parseNamespaces(flag: string, raw: string): Namespace[] {
  const seen = new Set<string>();
  const out: Namespace[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (s === '') continue;
    const ns = parseNamespace(flag, s);
    const key = `${ns.projectId}/${ns.env}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ns);
  }
  return out;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    tasks: [],
    port: parsePositiveIntEnv('PORT', process.env.PORT, 4848),
    // Loopback by default: a local runtime should not answer the subnet.
    host: process.env.BETTER_TRIGGER_HOST || '127.0.0.1',
    allowUnauthenticated: envFlag(process.env.BETTER_TRIGGER_ALLOW_UNAUTHENTICATED),
    // Beyond loopback, which the CORS allowlist always permits. Flags only:
    // BETTER_TRIGGER_CORS_ORIGIN is read by the middleware itself (an embedded
    // createApp() has no CLI), so seeding it here would list it twice.
    corsOrigins: [],
    concurrency: parsePositiveIntEnv(
      'BETTER_TRIGGER_CONCURRENCY',
      process.env.BETTER_TRIGGER_CONCURRENCY,
      5,
    ),
    databaseUrl: process.env.DATABASE_URL,
    migrate: true,
    serve: true,
    pinCodeVersion: envFlag(process.env.BETTER_TRIGGER_PIN_CODE_VERSION),
    // A run past this cap is claimed but marked stepsTruncated and failed
    // non-retryably (see executor.ts) — see parseMaxSteps for the defaults.
    maxSteps: parseMaxSteps(process.env.BETTER_TRIGGER_MAX_STEPS),
    // --namespace flags append to the env list; parseArgs defaults the result
    // to [DEFAULT_NAMESPACE] once both sources are in.
    namespaces: parseNamespaces('BETTER_TRIGGER_NAMESPACES', process.env.BETTER_TRIGGER_NAMESPACES ?? ''),
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
      case '--namespace':
        opts.namespaces.push(...parseNamespaces(flag, value()));
        break;
      default:
        throw new Error(`unknown option "${flag}" (try --help)`);
    }
  }

  // Dedup across env + flags, and default to the namespace every pre-namespace
  // row lives in: a daemon configured for nothing serves exactly default/prod.
  const seen = new Set<string>();
  opts.namespaces = opts.namespaces.filter((ns) => {
    const key = `${ns.projectId}/${ns.env}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (opts.namespaces.length === 0) opts.namespaces = [DEFAULT_NAMESPACE];

  return opts;
}

/**
 * `prune`'s own flag set, parsed the same strict way as the daemon's: unknown
 * flags are typos to report, and `--dry-run=false` has to mean false —
 * a bool flag that ignored its value would resolve a typo towards deleting.
 */
export function parsePruneArgs(argv: string[]): PruneOptions {
  let olderThanMs: number | undefined;
  const opts: Omit<PruneOptions, 'olderThanMs'> = {
    dryRun: false,
    namespaces: parseNamespaces('BETTER_TRIGGER_NAMESPACES', process.env.BETTER_TRIGGER_NAMESPACES ?? ''),
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
      case '--namespace':
        opts.namespaces.push(...parseNamespaces(flag, value()));
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
  // Same dedup + default as the daemon: prune is namespace-scoped, and a bare
  // `prune` must only ever see default/prod — never silently every namespace.
  const seen = new Set<string>();
  opts.namespaces = opts.namespaces.filter((ns) => {
    const key = `${ns.projectId}/${ns.env}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (opts.namespaces.length === 0) opts.namespaces = [DEFAULT_NAMESPACE];
  return { ...opts, olderThanMs };
}
