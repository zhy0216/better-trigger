/* =============================================================================
   @better-trigger/worker — Prometheus metrics (todos/03-operability.md O4).

   GET /api/v1/metrics → text/plain, the Prometheus exposition format.

   The dashboard's computeTaskStats answers "is this task slow" for a human
   reading a page. It cannot answer the questions an operator asks at 3am —
   how deep is the queue, is anything actually executing, has claim been
   failing since the last deploy, how much did the reaper have to recover.
   Those are cheap numbers; they just had nowhere to be read from.

   Two sources, deliberately:
     - two SQL gauges (queue depth by state, cluster-wide in-flight), one round
       trip, both over small or index-backed sets — see the query;
     - everything else is a live in-process counter, already maintained by the
       runtime and the orchestrator (observability.ts / kernel orchestrator.ts).
       This route only reads them. Nothing is defined twice.

   Auth: mounted under /api/v1, so app.ts's authMiddleware covers it exactly
   like every other route. It is NOT exempted the way /health is — /health has
   to answer a container probe that carries no key, whereas queue depth,
   throughput and failure counts describe the workload, and a metrics endpoint
   is a thing you point a scraper at, which can hold a bearer token. With no
   BETTER_TRIGGER_API_KEY set the whole API is open anyway and this is open
   with it; setting a key closes this too.
   ============================================================================= */
import { Hono } from 'hono';
import type { Pool } from 'pg';
import type { Namespace } from '@better-trigger/core';
import { DEFAULT_NAMESPACE } from '@better-trigger/core';
import {
  createOrchestratorCounters,
  type OrchestratorCounters,
} from '@better-trigger/kernel';
import {
  createNotifyCounters,
  createWorkerCounters,
  type NotifyCounters,
  type WorkerCounters,
} from '../observability';
// O4: the build metadata injected at build time — the same values /health
// reports, so "which commit is this scrape from" is answerable in Prometheus.
import { BUILD_SHA, BUILD_VERSION } from '../generated/build-info';

/** Every metric name is emitted under this prefix; see renderMetrics. */
const PREFIX = 'better_trigger_';

/** Content type of the Prometheus text exposition format (version 0.0.4). */
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Deadline for the gauge query's HTTP answer — a hung DB must not hang the
 * scrape. The query itself is cancelled earlier, server-side, by the probe
 * pool's statement_timeout (1s, PF4), so this deadline never outlives a live
 * query: it only bounds queueing behind other probes.
 */
const QUERY_TIMEOUT_MS = 2000;

/**
 * Live counters the route reads. Structural on purpose: a WorkerHandle and an
 * OrchestratorHandle's `counters` satisfy these as they are, so the daemon
 * passes what it already holds and nothing has to be copied per scrape.
 */
export interface MetricsSources {
  /** The execution runtime, when this process has one (a daemon started
   *  without --tasks serves the API and executes nothing). */
  worker?: { inFlightRunIds(): string[]; counters: WorkerCounters } | null;
  /** Orchestrator loop counters — the worker's, or the bookkeeping-only
   *  orchestrator an API-only process starts for itself. */
  orchestrator?: OrchestratorCounters | null;
  /** Notification fast-path counters (PF2) — the LISTEN connection's
   *  deliveries and reconnects, and how many waiters/claim sleeps it settled. */
  notify?: NotifyCounters | null;
  /** Business-pool connection checkout timeouts (pool saturation),
   *  process-wide — read directly because an API-only daemon has no worker
   *  counters to fold them into. */
  pool?: { poolCheckoutTimeouts: number } | null;
  /** Stray unhandledRejections (p1-13): logged, daemon keeps serving. A
   *  rising rate points at task code that never awaits its promises. */
  unhandledRejections?: { count: number } | null;
}

export type MetricType = 'counter' | 'gauge';

export interface MetricSample {
  labels?: Record<string, string>;
  value: number;
}

/** One metric and all of its label combinations, rendered as a single block. */
export interface MetricFamily {
  /** Without the prefix — renderMetrics adds it, so no metric can forget it. */
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

/* -------------------------------------------------------------- rendering */

/** Metric and label names: the character set the format allows. */
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Escapes for a HELP docstring: backslash and newline only (a `"` is literal
 * there). Everything printed here is a string literal in this file, but the
 * escaping is the format's, not the content's — the parser on the other end
 * splits on newlines, so one stray `\n` would silently truncate the family.
 */
function escapeHelp(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Label values additionally escape the quote that delimits them. */
function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Numbers as the format spells them: Go's parser accepts Inf/NaN by name, not
 * by JS's `Infinity`. Finite values go out via String(), which keeps integers
 * integral and never switches to a locale separator.
 */
function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

function renderLabels(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return '';
  const inner = entries
    .map(([k, v]) => {
      if (!NAME_RE.test(k)) throw new Error(`invalid metric label name: ${k}`);
      return `${k}="${escapeLabelValue(v)}"`;
    })
    .join(',');
  return `{${inner}}`;
}

/**
 * Families → exposition text. One HELP and one TYPE per family, immediately
 * followed by its samples, families never interleaved: that grouping is what
 * the format requires, and a scraper rejects the whole payload when it is
 * broken rather than dropping the offending line.
 */
export function renderMetrics(families: MetricFamily[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const family of families) {
    const name = `${PREFIX}${family.name}`;
    if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate metric family: ${name}`);
    seen.add(name);
    lines.push(`# HELP ${name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${name} ${family.type}`);
    for (const sample of family.samples) {
      lines.push(`${name}${renderLabels(sample.labels)} ${formatValue(sample.value)}`);
    }
  }
  // Trailing newline: the format is line-oriented and the last line counts.
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/* ------------------------------------------------------------- collection */

interface DbGauges {
  /** The namespace these counts describe (label on the emitted samples). */
  projectId: string;
  env: string;
  queueAvailable: number;
  queueScheduled: number;
  queueClaimed: number;
  running: number;
}

/**
 * The two SQL-backed quantities, in one round trip, per namespace.
 *
 * Namespace separation is the point (C2): queue depth and in-flight runs are
 * labelled with the (project_id, env) pair they were counted in, so an alert
 * on default/prod's queue never sees acme/staging's rows, and two namespaces
 * sharing a database stay distinguishable in one scrape.
 *
 * Cost: the queue aggregate is a full pass over `queue`, which is bounded by
 * design — rows are deleted on suspend and on every terminal outcome (see
 * kernel queue.ts removeFromQueue), so the table holds pending + claimed work,
 * not history. The running count is the one that would scan history, so it goes
 * through `runs_status_concurrency_idx` (project_id, env, status,
 * concurrency_key): the namespace equality is the index's leading columns and
 * status equality the next, so it touches only running rows.
 */
async function queryGauges(
  pool: Pool,
  namespaces: readonly Namespace[],
): Promise<DbGauges[]> {
  // VALUES pairing, like the kernel's claim scan: the namespaces come as
  // (project_id, env) pairs, not two parallel arrays that could misalign.
  const nsParams: unknown[] = [];
  const pairs = namespaces
    .map((ns, i) => {
      nsParams.push(ns.projectId, ns.env);
      return `($${i * 2 + 1}::text, $${i * 2 + 2}::text)`;
    })
    .join(', ');
  const res = await pool.query<{
    project_id: string;
    env: string;
    available: string;
    scheduled: string;
    claimed: string;
    running: string;
  }>(
    `SELECT q.project_id, q.env,
        count(*) FILTER (WHERE q.locked_by IS NULL AND q.available_at <= now()) AS available,
        count(*) FILTER (WHERE q.locked_by IS NULL AND q.available_at >  now()) AS scheduled,
        count(*) FILTER (WHERE q.locked_by IS NOT NULL)                         AS claimed,
        (SELECT count(*) FROM runs
          WHERE status = 'running' AND project_id = q.project_id AND env = q.env) AS running
       FROM queue q
      WHERE (q.project_id, q.env) IN (VALUES ${pairs})
      GROUP BY q.project_id, q.env`,
    nsParams,
  );
  // A configured namespace with an empty queue gets no row — emit zeros for it
  // rather than a missing series (a vanished series breaks rate() and reads as
  // an outage of the metric, exactly like the counters below).
  const byNs = new Map(
    namespaces.map((ns) => [
      `${ns.projectId}/${ns.env}`,
      {
        projectId: ns.projectId,
        env: ns.env,
        queueAvailable: 0,
        queueScheduled: 0,
        queueClaimed: 0,
        running: 0,
      },
    ]),
  );
  // count() comes back as bigint, i.e. a string over the wire.
  const n = (v: string | undefined): number => Number(v ?? 0);
  for (const row of res.rows) {
    const slot = byNs.get(`${row.project_id}/${row.env}`);
    if (!slot) continue;
    slot.queueAvailable = n(row.available);
    slot.queueScheduled = n(row.scheduled);
    slot.queueClaimed = n(row.claimed);
    slot.running = n(row.running);
  }
  return [...byNs.values()];
}

/**
 * queryGauges under a deadline, folded to null on any failure. Same shape as
 * the deep health probe's race, and for the same reason: folding both outcomes
 * into a value makes the race's winner *be* the answer instead of one outcome
 * arriving as a throw. This is presentation, not safety — the query itself is
 * cancelled by the probe pool's statement_timeout, so the loser's rejection is
 * PostgreSQL's, and `Promise.race` subscribes to every input, so a late
 * rejection is still an *observed* rejection and never becomes an
 * unhandledRejection.
 */
async function gaugesOrNull(
  pool: Pool,
  namespaces: readonly Namespace[],
): Promise<DbGauges[] | null> {
  const query = queryGauges(pool, namespaces).then(
    (g) => g,
    () => null,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), QUERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([query, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everything this process can say about itself right now.
 *
 * A process without a worker still exports the runtime counters as zeros: a
 * series that disappears between scrapes breaks rate() and reads as an outage
 * of the metric rather than an absence of the subsystem.
 *
 * `gauges` lets the route hand in a value it loaded through its single-flight
 * guard (PF4) instead of this function issuing its own query: pass
 * `undefined` to load here (the default — tests, embedded callers), pass the
 * guarded `DbGauges[] | null` to reuse one shared probe for every concurrent
 * scrape.
 */
export async function collectMetrics(
  pool: Pool,
  sources: MetricsSources = {},
  namespaces: readonly Namespace[] = [DEFAULT_NAMESPACE],
  gauges?: DbGauges[] | null,
): Promise<MetricFamily[]> {
  const worker = sources.worker ?? null;
  const counters = worker?.counters ?? createWorkerCounters();
  const orchestrator = sources.orchestrator ?? createOrchestratorCounters();
  const notify = sources.notify ?? createNotifyCounters();
  // The pool counter lives process-wide (sources.pool); the worker-counters
  // fallback keeps tests and embedded callers that only pass a worker working.
  const poolCheckoutTimeouts = sources.pool?.poolCheckoutTimeouts ?? counters.poolCheckoutTimeouts;
  // `undefined` means "load it" (the pre-PF4 path); `null` is a *failed* load
  // and must not trigger a second query.
  const g = gauges === undefined ? await gaugesOrNull(pool, namespaces) : gauges;

  const families: MetricFamily[] = [
    {
      name: 'db_up',
      help: 'Whether the metrics query reached Postgres on this scrape (1) or failed/timed out (0). The queue and in-flight gauges are absent when 0.',
      type: 'gauge',
      samples: [{ value: g ? 1 : 0 }],
    },
    // One sample per build (O4): a gauge whose value is always 1, labelled
    // with the package version and git sha this process was built from — the
    // same values /health reports. `sha` is absent for non-git builds.
    {
      name: 'build_info',
      help: 'The @better-trigger/worker build this process runs: package version and the git commit it was built from (absent when built outside a git checkout).',
      type: 'gauge',
      samples: [
        { labels: { version: BUILD_VERSION, ...(BUILD_SHA ? { sha: BUILD_SHA } : {}) }, value: 1 },
      ],
    },
  ];

  // Omitted rather than zeroed when the DB is unreachable: "queue depth 0" and
  // "queue depth unknown" must not look the same to an alert.
  if (g) {
    // One sample per configured namespace × state: the (project_id, env) label
    // pair is what keeps one namespace's backlog out of another's alert.
    families.push(
      {
        name: 'queue_depth',
        help: 'Rows in the queue table by namespace and state: available (due, unclaimed), scheduled (not due yet), claimed (leased to a worker).',
        type: 'gauge',
        samples: g.flatMap((gg) => [
          { labels: { project_id: gg.projectId, env: gg.env, state: 'available' }, value: gg.queueAvailable },
          { labels: { project_id: gg.projectId, env: gg.env, state: 'scheduled' }, value: gg.queueScheduled },
          { labels: { project_id: gg.projectId, env: gg.env, state: 'claimed' }, value: gg.queueClaimed },
        ]),
      },
      {
        name: 'inflight_runs',
        help: 'Runs in status running by namespace, across every worker on this database.',
        type: 'gauge',
        samples: g.map((gg) => ({
          labels: { project_id: gg.projectId, env: gg.env },
          value: gg.running,
        })),
      },
    );
  }

  families.push(
    {
      name: 'worker_inflight_runs',
      help: 'Runs executing in this process right now (0 when this daemon runs no tasks).',
      type: 'gauge',
      samples: [{ value: worker?.inFlightRunIds().length ?? 0 }],
    },
    {
      name: 'runs_total',
      help: 'Execution passes finished by this process, by outcome. Not run status: failed counts an attempt the executor reported as failed, which may still be retried; suspended is a run parked on a wait; abandoned is a lost claim handed back.',
      type: 'counter',
      samples: Object.entries(counters.runOutcomes).map(([outcome, value]) => ({
        labels: { outcome },
        value,
      })),
    },
    {
      name: 'claim_errors_total',
      help: 'Failed claim polls. A rising rate here with a non-empty queue is the "daemon looks idle but is not" failure.',
      type: 'counter',
      samples: [{ value: counters.claimErrors }],
    },
    {
      name: 'claim_errors_consecutive',
      help: 'Failed claim polls since the last one that succeeded. Non-zero and climbing means nothing is being picked up at all.',
      type: 'gauge',
      samples: [{ value: counters.consecutiveClaimErrors }],
    },
    {
      name: 'heartbeat_errors_total',
      help: 'Failed lease renewals. Every one of them is this worker drifting towards having its runs reaped out from under it.',
      type: 'counter',
      samples: [{ value: counters.heartbeatErrors }],
    },
    {
      name: 'heartbeat_errors_consecutive',
      help: 'Failed lease renewals since the last one that landed.',
      type: 'gauge',
      samples: [{ value: counters.consecutiveHeartbeatErrors }],
    },
    {
      name: 'executor_errors_total',
      help: 'Exceptions that escaped the executor into the claim loop (a bug: the run is left to the lease reaper).',
      type: 'counter',
      samples: [{ value: counters.executorErrors }],
    },
    {
      name: 'step_report_errors_total',
      help: 'Failed-step rows that could not be written back, so the run fails with the step that explains it missing from its timeline.',
      type: 'counter',
      samples: [{ value: counters.stepReportErrors }],
    },
    {
      name: 'fail_report_errors_total',
      help: 'Run failures that could not be written back to the database, so the run stays running until it is reaped.',
      type: 'counter',
      samples: [{ value: counters.failReportErrors }],
    },
    {
      name: 'log_flush_errors_total',
      help: 'Dropped run-log flushes.',
      type: 'counter',
      samples: [{ value: counters.logFlushErrors }],
    },
    {
      name: 'reaper_recovered_total',
      help: "Expired-lease claims recovered by this process's reaper: requeued to resume the same attempt (spending one recovery), or failed terminally as worker lost once the recovery budget ran out.",
      type: 'counter',
      samples: [
        { labels: { outcome: 'requeued' }, value: orchestrator.reaperRequeued },
        { labels: { outcome: 'failed' }, value: orchestrator.reaperFailed },
      ],
    },
    {
      name: 'pool_checkout_timeouts_total',
      help: 'Business-pool connection checkouts that timed out (connectionTimeoutMillis). Each one is a moment the pool was saturated — every client busy and the checkout queue waited too long; a rising rate means the pool is too small for the concurrency plus orchestrator/waiter headroom.',
      type: 'counter',
      samples: [{ value: poolCheckoutTimeouts }],
    },
    {
      name: 'unhandled_rejections_total',
      help: 'Stray unhandledRejections the daemon logged and survived (p1-13). Almost always a promise in task code that was never awaited; a rising rate is task hygiene, not a daemon fault. Set BETTER_TRIGGER_FATAL_UNHANDLED_REJECTION=1 to make them fatal instead.',
      type: 'counter',
      samples: [{ value: sources.unhandledRejections?.count ?? 0 }],
    },
    {
      name: 'orchestrator_errors_total',
      help: 'Background loop iterations that threw, by loop. These are swallowed to keep the loops alive, so the rate is the only sign.',
      type: 'counter',
      samples: Object.entries(orchestrator.loopErrors).map(([loop, value]) => ({
        labels: { loop },
        value,
      })),
    },
    {
      name: 'loop_last_success_timestamp',
      help: 'Epoch ms of the last tick that completed without throwing, per loop. A loop that stops advancing is stalled (the re-entrancy guard swallows the stall). Only loops this process actually runs are emitted — a deliberately-disabled loop has no series, so it cannot read as a stall.',
      type: 'gauge',
      // loopLastSuccess starts at 0 for every loop and is stamped after each
      // successful tick; emitting only the >0 loops keeps disabled loops out.
      samples: Object.entries(orchestrator.loopLastSuccess)
        .filter(([, value]) => value > 0)
        .map(([loop, value]) => ({ labels: { loop }, value })),
    },
    {
      name: 'stranded_runs',
      help: 'Due runs pinned to a code version no online worker serves, as of the last scan. Stays 0 unless --pin-code-version is on, where it is the cost of the guarantee: these runs wait for a worker that can replay their ledger. Alert on this one — it is always present, so a rule on it never silently stops evaluating.',
      type: 'gauge',
      samples: [
        { value: orchestrator.stranded.groups.reduce((n, g) => n + g.count, 0) },
      ],
    },
    {
      name: 'notifications_received_total',
      help: 'pg_notify messages this daemon received on the bt channel (PF2 notification fast-path).',
      type: 'counter',
      samples: [{ value: notify.notificationsReceived }],
    },
    {
      name: 'listen_reconnects_total',
      help: 'Times the LISTEN connection dropped and re-established itself. Polling covers the gap, so a high rate means an unstable database link rather than lost correctness.',
      type: 'counter',
      samples: [{ value: notify.listenReconnects }],
    },
    {
      name: 'waiter_resolutions_total',
      help: 'Result waiters settled by the in-process registry: reached a terminal state, or the run vanished (not_found).',
      type: 'counter',
      samples: [{ value: notify.waiterResolutions }],
    },
    {
      name: 'waiter_timeouts_total',
      help: 'Result waiters that hit their deadline and returned the latest non-terminal status.',
      type: 'counter',
      samples: [{ value: notify.waiterTimeouts }],
    },
    {
      name: 'claim_wakes_total',
      help: 'Times a work notification woke the idle claim loops instead of waiting out the idle backoff.',
      type: 'counter',
      samples: [{ value: notify.claimWakes }],
    },
  );

  // The breakdown answers the *next* question — which build has to come back —
  // so it carries labels, and it is pushed only when something is stranded: a
  // (task, version) series is meaningful while the condition lasts and is
  // nothing but stale cardinality afterwards. The unlabelled total above is
  // what stays put for alerting.
  if (orchestrator.stranded.groups.length > 0) {
    families.push({
      name: 'stranded_runs_by_version',
      help: 'Stranded runs broken down by task and the code version they are pinned to (capped at the largest groups). Present only while runs are actually stranded.',
      type: 'gauge',
      samples: orchestrator.stranded.groups.map((g) => ({
        labels: { task_id: g.taskId, code_version: g.codeVersion },
        value: g.count,
      })),
    });
  }

  return families;
}

/* --------------------------------------------------------------- the route */

export function metricsRoutes(deps: {
  pool: Pool;
  /** PF4: dedicated probe pool for the gauge query — a failed or hung scrape
   *  must never hold a business connection, and the pool's statement_timeout
   *  cancels the query server-side. Tests and embedded callers may omit it
   *  and share the business pool. */
  probePool?: Pool;
  metrics?: MetricsSources;
  /** Namespaces whose queue/in-flight gauges this daemon exports (default
   *  default/prod — the daemon's own configured scope, passed from main). */
  namespaces?: readonly Namespace[];
}): Hono {
  const app = new Hono();
  const probePool = deps.probePool ?? deps.pool;
  const namespaces = deps.namespaces ?? [DEFAULT_NAMESPACE];
  // PF4 single-flight guard: concurrent scrapes share ONE gauge query. Without
  // it a scrape storm could queue N queries on the probe pool (bounded at
  // max 2, but still queued and each paying statement_timeout); with it every
  // concurrent scrape gets the same probe's outcome, so the pool never has
  // more than one probe query in flight and a scrape storm cannot pile up
  // pending work on a half-dead database.
  let inflightGauges: Promise<DbGauges[] | null> | null = null;
  const loadGauges = (): Promise<DbGauges[] | null> => {
    inflightGauges ??= gaugesOrNull(probePool, namespaces).finally(() => {
      inflightGauges = null;
    });
    return inflightGauges;
  };

  app.get('/metrics', async (c) => {
    const gauges = await loadGauges();
    const families = await collectMetrics(
      probePool,
      deps.metrics ?? {},
      namespaces,
      gauges,
    );
    // Always 200, even with the database down: a scrape that fails tells the
    // operator "no data", while a scrape that succeeds with db_up 0 tells them
    // what is wrong — and still carries the in-process counters, which are
    // exactly what says how long it has been wrong.
    return c.body(renderMetrics(families), 200, { 'Content-Type': CONTENT_TYPE });
  });

  return app;
}
