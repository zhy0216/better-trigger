/* =============================================================================
   @better-trigger/worker — /api/v1/metrics tests (O4).

   The endpoint's whole value is that a scraper can read it, so the assertions
   go through a parser rather than `toContain`: a substring check passes on
   output whose HELP line is missing, whose families interleave, or whose label
   value ate an unescaped quote — and Prometheus rejects the entire payload for
   any of those, which is exactly the failure that must not ship silently.

   parseExposition below is deliberately strict and independent of the renderer
   (it re-implements the format from the spec: HELP/TYPE before samples, one
   family at a time, quoted-and-escaped label values). Driven through createApp
   with stub deps — no Postgres involved.
   ============================================================================= */
import type { Pool } from 'pg';
import type { Kernel, OrchestratorCounters } from '@better-trigger/kernel';
import { createOrchestratorCounters } from '@better-trigger/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { renderMetrics, type MetricFamily } from '../src/routes/metrics';
import { createWorkerCounters, type WorkerCounters } from '../src/observability';

/* ------------------------------------------------------- the parser under use */

interface ParsedSample {
  labels: Record<string, string>;
  value: number;
}
interface ParsedFamily {
  name: string;
  help: string;
  type: string;
  samples: ParsedSample[];
}

const NAME = '[a-zA-Z_:][a-zA-Z0-9_:]*';
const SAMPLE_RE = new RegExp(`^(${NAME})(?:\\{(.*)\\})? (.+)$`);
const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** The three escapes the format defines for a label value, reversed. */
function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === '"' ? '"' : ch === '\\' ? '\\' : `\\${ch}`,
  );
}

function parseLabels(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw === '') return {};
  const labels: Record<string, string> = {};
  let consumed = 0;
  LABEL_RE.lastIndex = 0;
  for (let m = LABEL_RE.exec(raw); m; m = LABEL_RE.exec(raw)) {
    if (m.index !== consumed) throw new Error(`unparsable label section: {${raw}}`);
    labels[m[1]!] = unescape(m[2]!);
    consumed = LABEL_RE.lastIndex;
    if (raw[consumed] === ',') consumed += 1;
  }
  if (consumed !== raw.length) throw new Error(`unparsable label section: {${raw}}`);
  return labels;
}

function parseValue(raw: string): number {
  if (raw === '+Inf') return Infinity;
  if (raw === '-Inf') return -Infinity;
  if (raw === 'NaN') return NaN;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`not a metric value: "${raw}"`);
  return n;
}

/**
 * Parse the exposition format, throwing on anything a scraper would reject:
 * a sample without HELP/TYPE, a repeated or late metadata line, a family whose
 * samples are split by another family, a malformed value or label section.
 */
function parseExposition(text: string): Map<string, ParsedFamily> {
  if (text !== '' && !text.endsWith('\n')) throw new Error('missing trailing newline');
  const families = new Map<string, ParsedFamily>();
  let current: string | null = null;

  for (const line of text.split('\n')) {
    if (line === '') continue;

    const meta = /^# (HELP|TYPE) (\S+) ?(.*)$/.exec(line);
    if (meta) {
      const [, kind, name, rest] = meta as unknown as [string, string, string, string];
      if (kind === 'HELP') {
        if (families.has(name)) throw new Error(`HELP after samples/HELP for ${name}`);
        families.set(name, { name, help: rest, type: '', samples: [] });
        current = name;
        continue;
      }
      const family = families.get(name);
      if (!family) throw new Error(`TYPE before HELP for ${name}`);
      if (family.type !== '') throw new Error(`duplicate TYPE for ${name}`);
      if (family.samples.length > 0) throw new Error(`TYPE after samples for ${name}`);
      if (!['counter', 'gauge', 'histogram', 'summary', 'untyped'].includes(rest)) {
        throw new Error(`unknown metric type "${rest}" for ${name}`);
      }
      family.type = rest;
      continue;
    }

    if (line.startsWith('#')) continue; // a plain comment is legal
    const m = SAMPLE_RE.exec(line);
    if (!m) throw new Error(`unparsable sample line: ${line}`);
    const [, name, labels, value] = m as unknown as [string, string, string, string];
    const family = families.get(name);
    if (!family) throw new Error(`sample without HELP/TYPE: ${name}`);
    if (family.type === '') throw new Error(`sample before TYPE: ${name}`);
    // Samples of one family must be contiguous.
    if (current !== name) throw new Error(`family ${name} interleaved with ${current}`);
    family.samples.push({ labels: parseLabels(labels), value: parseValue(value) });
  }

  for (const family of families.values()) {
    if (family.type === '') throw new Error(`HELP without TYPE for ${family.name}`);
    if (family.help === '') throw new Error(`empty HELP for ${family.name}`);
  }
  return families;
}

/* --------------------------------------------------------------- fixtures */

const kernel = {} as unknown as Kernel;

const GAUGE_ROW = { available: '7', scheduled: '2', claimed: '3', running: '3' };

interface Fixture {
  worker?: { inFlightRunIds(): string[]; counters: WorkerCounters } | null;
  orchestrator?: OrchestratorCounters | null;
  query?: (...args: unknown[]) => Promise<unknown>;
}

function makeApp(fx: Fixture = {}) {
  const pool = {
    query: fx.query ?? (async () => ({ rows: [GAUGE_ROW] })),
  } as unknown as Pool;
  return createApp({
    kernel,
    pool,
    metrics: { worker: fx.worker ?? null, orchestrator: fx.orchestrator ?? null },
  });
}

const get = (path = '/api/v1/metrics') => new Request(`http://localhost:4848${path}`);

/** Scrape an app and hand back the parsed families. */
async function scrape(fx: Fixture = {}): Promise<{
  res: Response;
  families: Map<string, ParsedFamily>;
}> {
  const res = await makeApp(fx).fetch(get());
  return { res, families: parseExposition(await res.text()) };
}

const sampleValue = (
  families: Map<string, ParsedFamily>,
  name: string,
  labels: Record<string, string> = {},
): number => {
  const family = families.get(name);
  if (!family) throw new Error(`no such family: ${name}`);
  const found = family.samples.find(
    (s) => JSON.stringify(s.labels) === JSON.stringify(labels),
  );
  if (!found) throw new Error(`no sample ${name}${JSON.stringify(labels)}`);
  return found.value;
};

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.BETTER_TRIGGER_API_KEY;
  delete process.env.BETTER_TRIGGER_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.BETTER_TRIGGER_API_KEY;
  else process.env.BETTER_TRIGGER_API_KEY = savedKey;
});

/* ------------------------------------------------------------------ tests */

describe('the parser these tests rely on', () => {
  // A parser that accepts everything would make every assertion below vacuous.
  it('rejects the malformed payloads a scraper rejects', () => {
    expect(() => parseExposition('better_trigger_x 1\n')).toThrow(/without HELP/);
    expect(() =>
      parseExposition('# HELP better_trigger_x h\nbetter_trigger_x 1\n'),
    ).toThrow(/before TYPE/);
    expect(() =>
      parseExposition(
        '# HELP a h\n# TYPE a gauge\na 1\n# HELP b h\n# TYPE b gauge\nb 1\na 2\n',
      ),
    ).toThrow(/interleaved/);
    expect(() =>
      parseExposition('# HELP a h\n# TYPE a gauge\na{k="un"quoted"} 1\n'),
    ).toThrow(/unparsable/);
    expect(() => parseExposition('# HELP a h\n# TYPE a gauge\na abc\n')).toThrow(
      /not a metric value/,
    );
    expect(() => parseExposition('# HELP a h\n# TYPE a gauge\na 1')).toThrow(
      /trailing newline/,
    );
  });
});

describe('exposition format', () => {
  it('parses as Prometheus text, every family typed and documented', async () => {
    const { res, families } = await scrape();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(families.size).toBeGreaterThan(0);
    for (const family of families.values()) {
      expect(family.name.startsWith('better_trigger_')).toBe(true);
      expect(['counter', 'gauge']).toContain(family.type);
      expect(family.samples.length).toBeGreaterThan(0);
    }
  });

  it('names counters *_total and never suffixes a gauge with it', async () => {
    const { families } = await scrape();
    for (const family of families.values()) {
      expect(family.name.endsWith('_total')).toBe(family.type === 'counter');
    }
  });

  it('rejects a metric name the format does not allow', () => {
    const bad: MetricFamily[] = [
      { name: 'queue-depth', help: 'h', type: 'gauge', samples: [{ value: 1 }] },
    ];
    expect(() => renderMetrics(bad)).toThrow(/invalid metric name/);
  });

  it('rejects two families sharing a name', () => {
    const dup: MetricFamily[] = [
      { name: 'a', help: 'h', type: 'gauge', samples: [{ value: 1 }] },
      { name: 'a', help: 'h', type: 'counter', samples: [{ value: 1 }] },
    ];
    expect(() => renderMetrics(dup)).toThrow(/duplicate metric family/);
  });

  it('escapes label values so a quote cannot end the label early', () => {
    // Nothing emits these today, but the renderer is what would have to be
    // fixed the day a label carries a task id or an error code.
    const value = 'a"b\\c\nd';
    const text = renderMetrics([
      { name: 'x', help: 'h', type: 'gauge', samples: [{ labels: { k: value }, value: 1 }] },
    ]);
    expect(text).toContain('k="a\\"b\\\\c\\nd"');
    expect(sampleValue(parseExposition(text), 'better_trigger_x', { k: value })).toBe(1);
  });

  it('escapes a newline in HELP instead of splitting the family', () => {
    const text = renderMetrics([
      { name: 'x', help: 'one\ntwo', type: 'gauge', samples: [{ value: 1 }] },
    ]);
    expect(text.split('\n')).toHaveLength(4); // HELP, TYPE, sample, trailing ''
    expect(parseExposition(text).get('better_trigger_x')?.help).toBe('one\\ntwo');
  });

  it('spells the non-finite values the way the format does', () => {
    const text = renderMetrics([
      {
        name: 'x',
        help: 'h',
        type: 'gauge',
        samples: [
          { labels: { k: 'inf' }, value: Infinity },
          { labels: { k: 'nan' }, value: NaN },
        ],
      },
    ]);
    const families = parseExposition(text);
    expect(sampleValue(families, 'better_trigger_x', { k: 'inf' })).toBe(Infinity);
    expect(sampleValue(families, 'better_trigger_x', { k: 'nan' })).toBeNaN();
  });
});

describe('database gauges', () => {
  it('reports queue depth by state and cluster-wide in-flight in one query', async () => {
    const query = vi.fn(async () => ({ rows: [GAUGE_ROW] }));
    const { families } = await scrape({ query });

    expect(query).toHaveBeenCalledTimes(1);
    expect(sampleValue(families, 'better_trigger_db_up')).toBe(1);
    expect(sampleValue(families, 'better_trigger_queue_depth', { state: 'available' })).toBe(7);
    expect(sampleValue(families, 'better_trigger_queue_depth', { state: 'scheduled' })).toBe(2);
    expect(sampleValue(families, 'better_trigger_queue_depth', { state: 'claimed' })).toBe(3);
    expect(sampleValue(families, 'better_trigger_inflight_runs')).toBe(3);
  });

  it('reads the counts off queue and runs, not off a full history scan', async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [GAUGE_ROW] }));
    await scrape({ query });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toMatch(/FROM queue/);
    // The one predicate that keeps the runs count on runs_status_concurrency_idx.
    expect(sql).toMatch(/FROM runs WHERE status = 'running'/);
  });

  it('drops the DB gauges and flips db_up when the query fails', async () => {
    const { res, families } = await scrape({
      query: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.4:5432');
      },
    });

    // Still a successful scrape: the counters are what say how long it has
    // been broken, and db_up 0 is the alertable fact.
    expect(res.status).toBe(200);
    expect(sampleValue(families, 'better_trigger_db_up')).toBe(0);
    expect(families.has('better_trigger_queue_depth')).toBe(false);
    expect(families.has('better_trigger_inflight_runs')).toBe(false);
    // In-process metrics survive the outage.
    expect(families.has('better_trigger_claim_errors_total')).toBe(true);
  });

  it('leaks neither the pg message nor the host on a failure', async () => {
    const app = makeApp({
      query: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.4:5432');
      },
    });
    const text = await (await app.fetch(get())).text();
    expect(text).not.toContain('10.0.0.4');
    expect(text).not.toContain('ECONNREFUSED');
  });

  it('gives up on a hung query instead of hanging the scrape with it', async () => {
    vi.useFakeTimers();
    try {
      const app = makeApp({ query: () => new Promise(() => {}) });
      const pending = app.fetch(get());
      await vi.advanceTimersByTimeAsync(2000);
      const families = parseExposition(await (await pending).text());
      expect(sampleValue(families, 'better_trigger_db_up')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // There is deliberately no test for "the hung query rejects after the
  // deadline takes the daemon down". That cannot happen and so cannot regress:
  // `Promise.race` subscribes to *every* input, so the loser's late rejection
  // is already observed by the race itself — it never reaches
  // process.on('unhandledRejection'), whatever gaugesOrNull does with the
  // winner. A test asserting that handler stays silent is green against any
  // implementation, i.e. it is not a test. The property worth pinning — a hung
  // query degrades the scrape instead of hanging it — is covered above.
});

describe('in-process counters', () => {
  it('exports the runtime counters the swallowed catches maintain', async () => {
    const counters = createWorkerCounters();
    counters.claimErrors = 412;
    counters.consecutiveClaimErrors = 91;
    counters.heartbeatErrors = 5;
    counters.consecutiveHeartbeatErrors = 0;
    counters.executorErrors = 1;
    counters.stepReportErrors = 6;
    counters.failReportErrors = 2;
    counters.logFlushErrors = 3;
    counters.runOutcomes.completed = 100;
    counters.runOutcomes.failed = 4;
    counters.runOutcomes.suspended = 8;
    counters.runOutcomes.abandoned = 1;

    const { families } = await scrape({
      worker: { inFlightRunIds: () => ['run_a', 'run_b'], counters },
    });

    expect(sampleValue(families, 'better_trigger_claim_errors_total')).toBe(412);
    expect(sampleValue(families, 'better_trigger_claim_errors_consecutive')).toBe(91);
    expect(sampleValue(families, 'better_trigger_heartbeat_errors_total')).toBe(5);
    expect(sampleValue(families, 'better_trigger_heartbeat_errors_consecutive')).toBe(0);
    expect(sampleValue(families, 'better_trigger_executor_errors_total')).toBe(1);
    expect(sampleValue(families, 'better_trigger_step_report_errors_total')).toBe(6);
    expect(sampleValue(families, 'better_trigger_fail_report_errors_total')).toBe(2);
    expect(sampleValue(families, 'better_trigger_log_flush_errors_total')).toBe(3);
    expect(sampleValue(families, 'better_trigger_worker_inflight_runs')).toBe(2);

    const outcomes = families.get('better_trigger_runs_total')!;
    expect(outcomes.samples.map((s) => [s.labels.outcome, s.value])).toEqual([
      ['completed', 100],
      ['failed', 4],
      ['suspended', 8],
      ['abandoned', 1],
    ]);
  });

  it('reads live counters, not a snapshot taken at wiring time', async () => {
    // The route holds the runtime's own object; a copy would freeze at zero.
    const counters = createWorkerCounters();
    const app = makeApp({ worker: { inFlightRunIds: () => [], counters } });

    expect(
      sampleValue(parseExposition(await (await app.fetch(get())).text()), 'better_trigger_claim_errors_total'),
    ).toBe(0);
    counters.claimErrors = 7;
    expect(
      sampleValue(parseExposition(await (await app.fetch(get())).text()), 'better_trigger_claim_errors_total'),
    ).toBe(7);
  });

  it('exports the reaper and loop counters from the orchestrator', async () => {
    const orchestrator = createOrchestratorCounters();
    orchestrator.reaperRequeued = 12;
    orchestrator.reaperFailed = 3;
    orchestrator.loopErrors.cron = 6;

    const { families } = await scrape({ orchestrator });
    expect(
      sampleValue(families, 'better_trigger_reaper_recovered_total', { outcome: 'requeued' }),
    ).toBe(12);
    expect(
      sampleValue(families, 'better_trigger_reaper_recovered_total', { outcome: 'failed' }),
    ).toBe(3);
    expect(
      sampleValue(families, 'better_trigger_orchestrator_errors_total', { loop: 'cron' }),
    ).toBe(6);
    expect(
      sampleValue(families, 'better_trigger_orchestrator_errors_total', { loop: 'reaper' }),
    ).toBe(0);
  });

  it('keeps the series alive as zeros on a daemon that runs no tasks', async () => {
    // A vanishing series reads as a broken metric, not as an absent subsystem,
    // and breaks rate() over the restart.
    const { families } = await scrape({ worker: null, orchestrator: null });
    expect(sampleValue(families, 'better_trigger_claim_errors_total')).toBe(0);
    expect(sampleValue(families, 'better_trigger_worker_inflight_runs')).toBe(0);
    expect(sampleValue(families, 'better_trigger_runs_total', { outcome: 'completed' })).toBe(0);
    expect(
      sampleValue(families, 'better_trigger_reaper_recovered_total', { outcome: 'requeued' }),
    ).toBe(0);
  });

  it('still answers when the app was assembled without a metrics source', async () => {
    // The embedded case: createApp({ kernel, pool }) with no third field.
    const pool = { query: async () => ({ rows: [GAUGE_ROW] }) } as unknown as Pool;
    const res = await createApp({ kernel, pool }).fetch(get());
    const families = parseExposition(await res.text());
    expect(sampleValue(families, 'better_trigger_queue_depth', { state: 'available' })).toBe(7);
    expect(sampleValue(families, 'better_trigger_worker_inflight_runs')).toBe(0);
  });
});

describe('auth', () => {
  it('requires the bearer token once an API key is configured', async () => {
    // Unlike /health: queue depth and throughput describe the workload, and a
    // scraper has somewhere to put a token.
    process.env.BETTER_TRIGGER_API_KEY = 'sk-local-abcdefghijklmnop';
    const res = await makeApp().fetch(get());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'invalid or missing API key' },
    });
  });

  it('answers a scraper that sends the key', async () => {
    process.env.BETTER_TRIGGER_API_KEY = 'sk-local-abcdefghijklmnop';
    const res = await makeApp().fetch(
      new Request('http://localhost:4848/api/v1/metrics', {
        headers: { Authorization: 'Bearer sk-local-abcdefghijklmnop' },
      }),
    );
    expect(res.status).toBe(200);
    expect(parseExposition(await res.text()).size).toBeGreaterThan(0);
  });

  it('is open when no key is set, like the rest of the API', async () => {
    expect((await makeApp().fetch(get())).status).toBe(200);
  });
});
