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
import {
  createOrchestratorCounters,
  type OrchestratorCounters,
} from '@better-trigger/kernel';
import { createWorkerCounters, type WorkerCounters } from '../observability';

/** Every metric name is emitted under this prefix; see renderMetrics. */
const PREFIX = 'better_trigger_';

/** Content type of the Prometheus text exposition format (version 0.0.4). */
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Deadline for the gauge query — a hung DB must not hang the scrape. */
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
  queueAvailable: number;
  queueScheduled: number;
  queueClaimed: number;
  running: number;
}

/**
 * The two SQL-backed quantities, in one round trip.
 *
 * Cost: the queue aggregate is a full pass over `queue`, which is bounded by
 * design — rows are deleted on suspend and on every terminal outcome (see
 * kernel queue.ts removeFromQueue), so the table holds pending + claimed work,
 * not history. The running count is the one that would scan history, so it goes
 * through `runs_status_concurrency_idx` (status, concurrency_key): status
 * equality is that index's leading column, so it touches only running rows.
 */
async function queryGauges(pool: Pool): Promise<DbGauges> {
  const res = await pool.query<{
    available: string;
    scheduled: string;
    claimed: string;
    running: string;
  }>(
    `SELECT
        count(*) FILTER (WHERE q.locked_by IS NULL AND q.available_at <= now()) AS available,
        count(*) FILTER (WHERE q.locked_by IS NULL AND q.available_at >  now()) AS scheduled,
        count(*) FILTER (WHERE q.locked_by IS NOT NULL)                         AS claimed,
        (SELECT count(*) FROM runs WHERE status = 'running')                     AS running
       FROM queue q`,
  );
  const row = res.rows[0];
  // count() comes back as bigint, i.e. a string over the wire.
  const n = (v: string | undefined): number => Number(v ?? 0);
  return {
    queueAvailable: n(row?.available),
    queueScheduled: n(row?.scheduled),
    queueClaimed: n(row?.claimed),
    running: n(row?.running),
  };
}

/**
 * queryGauges under a deadline, folded to null on any failure. Same shape as
 * the deep health probe's race, and for the same reason: folding both outcomes
 * into a value makes the race's winner *be* the answer instead of one outcome
 * arriving as a throw. This is presentation, not safety — `Promise.race`
 * subscribes to every input, so a loser rejecting after the deadline is still
 * an *observed* rejection and never becomes an unhandledRejection.
 */
async function gaugesOrNull(pool: Pool): Promise<DbGauges | null> {
  const query = queryGauges(pool).then(
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
 */
export async function collectMetrics(
  pool: Pool,
  sources: MetricsSources = {},
): Promise<MetricFamily[]> {
  const worker = sources.worker ?? null;
  const counters = worker?.counters ?? createWorkerCounters();
  const orchestrator = sources.orchestrator ?? createOrchestratorCounters();
  const gauges = await gaugesOrNull(pool);

  const families: MetricFamily[] = [
    {
      name: 'db_up',
      help: 'Whether the metrics query reached Postgres on this scrape (1) or failed/timed out (0). The queue and in-flight gauges are absent when 0.',
      type: 'gauge',
      samples: [{ value: gauges ? 1 : 0 }],
    },
  ];

  // Omitted rather than zeroed when the DB is unreachable: "queue depth 0" and
  // "queue depth unknown" must not look the same to an alert.
  if (gauges) {
    families.push(
      {
        name: 'queue_depth',
        help: 'Rows in the queue table by state: available (due, unclaimed), scheduled (not due yet), claimed (leased to a worker).',
        type: 'gauge',
        samples: [
          { labels: { state: 'available' }, value: gauges.queueAvailable },
          { labels: { state: 'scheduled' }, value: gauges.queueScheduled },
          { labels: { state: 'claimed' }, value: gauges.queueClaimed },
        ],
      },
      {
        name: 'inflight_runs',
        help: 'Runs in status running, across every worker on this database.',
        type: 'gauge',
        samples: [{ value: gauges.running }],
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
      name: 'orchestrator_errors_total',
      help: 'Background loop iterations that threw, by loop. These are swallowed to keep the loops alive, so the rate is the only sign.',
      type: 'counter',
      samples: Object.entries(orchestrator.loopErrors).map(([loop, value]) => ({
        labels: { loop },
        value,
      })),
    },
  );

  return families;
}

/* --------------------------------------------------------------- the route */

export function metricsRoutes(deps: { pool: Pool; metrics?: MetricsSources }): Hono {
  const app = new Hono();

  app.get('/metrics', async (c) => {
    const families = await collectMetrics(deps.pool, deps.metrics ?? {});
    // Always 200, even with the database down: a scrape that fails tells the
    // operator "no data", while a scrape that succeeds with db_up 0 tells them
    // what is wrong — and still carries the in-process counters, which are
    // exactly what says how long it has been wrong.
    return c.body(renderMetrics(families), 200, { 'Content-Type': CONTENT_TYPE });
  });

  return app;
}
