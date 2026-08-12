/* =============================================================================
   @better-trigger/worker — dashboard read API.
   GET /health · /tasks · /runs · /runs/:id · /schedules · PATCH /schedules/:id
   · GET /workers (online-only + LIMIT by default). See docs/backend-contract.md §5.
   ============================================================================= */
import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import type { Namespace, RunStatus } from '@better-trigger/core';
import { getRunDetail, KernelError, nextCronAt } from '@better-trigger/kernel';
import type {
  HealthPoolStats,
  HealthResponse,
  OkResponse,
  RunDetailResponse,
  RunsResponse,
  RunSummary,
  ScheduleSummary,
  SchedulesResponse,
  TaskSummary,
  TasksResponse,
  UpdateScheduleRequest,
  WorkerSummary,
  WorkersResponse,
} from '../types';
import { computeTaskStats } from '../stats';

/** The run status values GET /runs accepts — the /workers route's status
 *  check made into a shared contract (p2-32): a typo 400s instead of silently
 *  returning an empty page. */
const RUN_STATUSES: ReadonlySet<string> = new Set<RunStatus>(['queued', 'running', 'waiting', 'completed', 'failed', 'canceled']);
import { intQuery, requireBoolean, safeJson } from '../http';
import { namespaceFromQuery } from '../namespace';
// O4: the build metadata injected at build time (package version + git sha,
// see scripts/write-build-info.mjs). The committed fallback serves source
// checkouts; dist/ always carries the values the build was made from, so
// /health.version matches the published package version and `sha` names the
// commit it was built from.
import { BUILD_SHA, BUILD_VERSION } from '../generated/build-info';

/** Deadline for the deep probe's SELECT 1 — a hung DB must not hang the probe. */
const DEEP_PROBE_TIMEOUT_MS = 2000;

/** Default TTL for the /tasks stats cache. The web dashboard polls /tasks
 *  every 2s and the 24h-window aggregates cannot meaningfully change within
 *  10s (PF1, todos/02-performance.md), so the cache absorbs the poll storm
 *  without the dashboard ever seeing stats older than the TTL. */
const DEFAULT_STATS_TTL_MS = 10_000;

/**
 * Read per request, like the body limit, so a test (or a reload) can flip it
 * without re-assembly. `0` disables the cache entirely (every request
 * re-queries).
 */
function statsTtlMs(): number {
  const raw = process.env.BETTER_TRIGGER_STATS_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_STATS_TTL_MS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_STATS_TTL_MS;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const durationMs = (started: Date | null, finished: Date | null): number | null =>
  started && finished ? finished.getTime() - started.getTime() : null;

/**
 * Task ids out of a `workers.tasks` jsonb value. Registration writes
 * `[{ id, codeVersion }]` (the stranded-run scan needs the versions), but rows
 * written by an older build hold `["id"]` — and worker rows outlive the process
 * that wrote them, so both shapes are live data, not a migration window. The
 * dashboard contract is ids either way.
 */
function workerTaskIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => (typeof e === 'string' ? e : (e as { id?: unknown } | null)?.id))
    .filter((id): id is string => typeof id === 'string');
}

/**
 * `SELECT 1` under a deadline. Postgres being unreachable is not always a
 * refused connection: a dead peer, a saturated pool or a paused container all
 * leave the query pending forever, and a probe that waits with it is no better
 * than no probe at all — a timeout counts as unhealthy.
 *
 * The caller hands the *probe pool* (PF4), never the business pool: a hung or
 * failing probe can therefore not hold a business connection, and the probe
 * pool's statement_timeout is what actually cancels the query — PostgreSQL
 * kills the SELECT 1 after ~1s and the connection returns to the pool. The
 * race below is then only the HTTP answer deadline, not the resource safety
 * net (which is why it can stay at 2s, ahead of the query's own 1s).
 */
async function probeDb(pool: Pool): Promise<NonNullable<HealthResponse['db']>> {
  // The connection lifecycle is ours (fix direction B): pool.connect() +
  // client.release(), exactly once per outcome, so a probe can never strand a
  // checked-out client. The continuation releases on success and on query
  // failure; the finally below releases when the deadline won — whichever
  // fires first sets `released`, so the late path is a no-op (and pg-pool
  // discards a client released with an in-flight query, so capacity is
  // preserved even when the query outlives the deadline).
  let client: PoolClient | null = null;
  let released = false;
  const releaseOnce = (c: PoolClient): void => {
    if (!released) {
      released = true;
      c.release();
    }
  };
  const query = pool.connect().then(
    (c) => {
      client = c;
      return c.query('SELECT 1').then(
        () => {
          releaseOnce(c);
          return 'ok' as const;
        },
        () => {
          releaseOnce(c);
          return 'query_failed' as const;
        },
      );
    },
    () => 'query_failed' as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), DEEP_PROBE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([query, deadline]);
    return outcome === 'ok' ? { ok: true } : { ok: false, error: outcome };
  } finally {
    // A pending timer holds the event loop open, so a probe that answered in a
    // millisecond would still pin the process for the full deadline — and a
    // SIGTERM landing right after a healthcheck would wait on it. Release
    // whatever the continuation acquired if it has not released already.
    clearTimeout(timer);
    if (client) releaseOnce(client);
  }
}

/** pg's own counters; a pool stub (tests, embedded use) may not carry them. */
function poolStats(pool: Pool): HealthPoolStats {
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return { total: n(pool.totalCount), idle: n(pool.idleCount), waiting: n(pool.waitingCount) };
}

export function dashboardRoutes(deps: { pool: Pool; probePool?: Pool }): Hono {
  const { pool } = deps;
  // PF4: probes run on the dedicated probe pool (createHealthPool) when the
  // caller wired one — a hung/failing probe then cannot hold a business
  // connection, no matter how often it is called. Tests and embedded callers
  // may omit it and share the business pool (see AppDeps.probePool for the
  // trade-off).
  const probePool = deps.probePool ?? pool;
  // PF4 single-flight guard: concurrent deep probes share ONE probe query.
  // Without it a healthcheck storm could queue N queries on the probe pool
  // (bounded at max 2, but still queued and still each taking ~1s of
  // statement_timeout); with it the first probe's outcome IS the answer for
  // every concurrent caller, and the pool never has more than one in flight.
  let inflightProbe: Promise<NonNullable<HealthResponse['db']>> | null = null;
  const probe = (): Promise<NonNullable<HealthResponse['db']>> => {
    inflightProbe ??= probeDb(probePool).finally(() => {
      inflightProbe = null;
    });
    return inflightProbe;
  };
  const app = new Hono();

  // /tasks response cache, keyed by namespace, TTL'd via statsTtlMs(). Lives
  // in the route closure so every createApp() gets a fresh cache (tests never
  // see another app's entries).
  const statsCache = new Map<string, { at: number; tasks: TaskSummary[] }>();
  // Single-flight map for concurrent misses: requests for the same namespace
  // that miss together share ONE load instead of each running its own (the
  // web dashboard can fire parallel polls). The entry is removed when the
  // promise settles — success or failure — so a failed load never poisons
  // later requests.
  const inFlight = new Map<string, Promise<TaskSummary[]>>();

  /** Load the /tasks payload for one namespace: task list + 24h stats. */
  async function loadTasks(namespace: Namespace): Promise<TaskSummary[]> {
    const [taskRows, stats] = await Promise.all([
      pool.query<{
        id: string;
        name: string;
        file_path: string | null;
        trigger_source: string;
        cron_pattern: string | null;
      }>(
        `SELECT id, name, file_path, trigger_source, cron_pattern
           FROM tasks WHERE project_id = $1 AND env = $2 ORDER BY name ASC`,
        [namespace.projectId, namespace.env],
      ),
      computeTaskStats(pool, namespace),
    ]);

    return taskRows.rows.map((t) => {
      const s = stats.get(t.id);
      return {
        id: t.id,
        name: t.name,
        filePath: t.file_path,
        triggerSource: t.trigger_source === 'schedule' ? 'schedule' : 'api',
        cronPattern: t.cron_pattern,
        runs24h: s?.runs24h ?? 0,
        p50Ms: s?.p50Ms ?? null,
        p95Ms: s?.p95Ms ?? null,
        successRate: s?.successRate ?? null,
        trend: s?.trend ?? new Array<number>(12).fill(0),
        lastRunAt: s?.lastRunAt ?? null,
      };
    });
  }

  /* -------------------------------------------------------- health */
  /**
   * Two probes on one path:
   *
   *   GET /health          liveness — the process answers, nothing else asked
   *   GET /health?deep=1   readiness — SELECT 1 + pool counts, 503 when the DB
   *                        is unreachable (container healthcheck, k8s readiness)
   *
   * One path because middleware.ts opens exactly '/api/v1/health' to
   * unauthenticated callers and a healthcheck has no API key to send. Which
   * also means the deep body answers anyone, so it carries no DB error text:
   * pg messages name the host ('connect ECONNREFUSED 10.0.0.4:5432') and
   * sometimes the connection string. Counters are numbers — they say
   * "saturated" without saying where.
   */
  app.get('/health', async (c) => {
    const deep = c.req.query('deep');
    if (deep !== '1' && deep !== 'true') {
      const res: HealthResponse = { ok: true, version: BUILD_VERSION, sha: BUILD_SHA };
      return c.json(res);
    }
    const db = await probe();
    const res: HealthResponse = { ok: db.ok, version: BUILD_VERSION, sha: BUILD_SHA, db, pool: poolStats(pool) };
    return c.json(res, db.ok ? 200 : 503);
  });

  /* --------------------------------------------------------- tasks */
  app.get('/tasks', async (c) => {
    // Every read route scopes on one namespace (default default/prod — the
    // "single namespace by default" visibility boundary). The dashboard never
    // sees every namespace at once; ?projectId=/?env= moves the window.
    const ns = namespaceFromQuery(c);
    // Namespace parts may contain '/' (assertNamespace only bans ':'), so a
    // joined key could collide: {projectId:'a/b', env:'c'} and
    // {projectId:'a', env:'b/c'} would both produce 'a/b/c' and leak one
    // namespace's stats into the other. JSON-encoding the pair is
    // unambiguous, so the key can never alias.
    const cacheKey = JSON.stringify([ns.projectId, ns.env]);

    // Short per-namespace cache (10s default, BETTER_TRIGGER_STATS_TTL_MS):
    // the 24h aggregates and the task list cannot change within the TTL, and
    // the dashboard polls every 2s — without this every poll re-runs the task
    // list plus the runs aggregations, which grow with history when retention
    // is off (PF1, todos/02-performance.md). A hit issues zero queries.
    const hit = statsCache.get(cacheKey);
    const ttlMs = statsTtlMs();
    if (hit !== undefined && Date.now() - hit.at < ttlMs) {
      return c.json({ tasks: hit.tasks } satisfies TasksResponse);
    }

    let pending = inFlight.get(cacheKey);
    if (pending === undefined) {
      pending = loadTasks(ns).finally(() => {
        inFlight.delete(cacheKey);
      });
      inFlight.set(cacheKey, pending);
    }
    const tasks = await pending;

    // Store only after the load succeeded, so a failure never poisons the
    // cache. Namespace keys are few, but cap the map so a poller cycling many
    // namespaces cannot grow it forever.
    statsCache.set(cacheKey, { at: Date.now(), tasks });
    if (statsCache.size > 64) {
      const oldest = statsCache.keys().next().value;
      if (oldest !== undefined) statsCache.delete(oldest);
    }

    return c.json({ tasks } satisfies TasksResponse);
  });

  /* ---------------------------------------------------------- runs */
  app.get('/runs', async (c) => {
    // ?projectId=&env= pick the namespace (default default/prod); taskId and
    // status filter inside it. A run in another namespace is never visible.
    const ns = namespaceFromQuery(c);
    const taskId = c.req.query('taskId');
    // Same enum contract as GET /workers (p2-32): a typo'd status must be a
    // 400 naming the legal values, NOT a silent empty page.
    const status = c.req.query('status');
    if (status !== undefined && !RUN_STATUSES.has(status)) {
      throw new KernelError(
        'bad_request',
        `status must be one of ${[...RUN_STATUSES].join(', ')}`,
      );
    }
    // limit goes straight into LIMIT $n, so it must be a positive integer before
    // pg sees it ("LIMIT must not be negative" / bigint syntax error → 500).
    const limit = intQuery(c, 'limit', { min: 1, max: 200, fallback: 50 });
    const cursor = c.req.query('cursor');

    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    add('project_id = $?', ns.projectId);
    add('env = $?', ns.env);
    if (taskId) add('task_id = $?', taskId);
    if (status) add('status = $?', status);

    // Keyset cursor = "<createdAtIso>|<id>"; page strictly older. Only cursors
    // we minted are valid: the timestamp half is compared against created_at,
    // so anything unparseable would surface as pg's "invalid input syntax for
    // type timestamp with time zone" → 500. Re-serialize it to be sure.
    if (cursor) {
      const sep = cursor.lastIndexOf('|');
      const cAt = new Date(sep > 0 ? cursor.slice(0, sep) : '');
      const cId = sep > 0 ? cursor.slice(sep + 1) : '';
      if (cId === '' || Number.isNaN(cAt.getTime())) {
        throw new KernelError('bad_request', 'cursor must be "<createdAt ISO>|<id>"');
      }
      params.push(cAt.toISOString());
      const p1 = params.length;
      params.push(cId);
      const p2 = params.length;
      where.push(`(created_at < $${p1} OR (created_at = $${p1} AND id < $${p2}))`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit + 1);
    const limitParam = params.length;

    const rows = await pool.query<{
      id: string;
      task_id: string;
      status: string;
      trigger_type: string;
      code_version: string | null;
      env: string;
      attempt: number;
      created_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
    }>(
      `SELECT id, task_id, status, trigger_type, code_version, env, attempt,
              created_at, started_at, finished_at
         FROM runs
         ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${limitParam}`,
      params,
    );

    const hasMore = rows.rows.length > limit;
    const page = hasMore ? rows.rows.slice(0, limit) : rows.rows;

    const runs: RunSummary[] = page.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      status: r.status as RunSummary['status'],
      trigger: r.trigger_type as RunSummary['trigger'],
      codeVersion: r.code_version,
      env: r.env,
      attempt: r.attempt,
      durationMs: durationMs(r.started_at, r.finished_at),
      createdAt: r.created_at.toISOString(),
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
    }));

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null;

    const res: RunsResponse = { runs, nextCursor };
    return c.json(res);
  });

  /* ------------------------------------------------------ runs/:id */
  app.get('/runs/:id', async (c) => {
    const id = c.req.param('id');
    // Scoped like the rest of the dashboard: the namespace is resolved from the
    // query so an id from another namespace reads as not_found, and the run
    // row carries its projectId as part of the wire shape (RunRecord).
    const ns = namespaceFromQuery(c);
    // PF3: the whole detail — run, steps, waits, logs — comes from the kernel's
    // ONE REPEATABLE READ snapshot. This route must not re-query those tables
    // itself: a second copy of the SQL would drift, and separate reads could
    // disagree mid-run. The kernel is the single source of truth.
    const logsBefore = c.req.query('logsBefore');
    const detail = await getRunDetail(pool, id, ns, {
      // Absent → the newest page; anything else is validated here so a typo
      // costs one parse, and re-validated in the kernel.
      logsBefore:
        logsBefore === undefined || logsBefore === ''
          ? undefined
          : intQuery(c, 'logsBefore', { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 1 }),
    });
    // not_found (another namespace / no such run) surfaces as the kernel's
    // 404 through app.onError, same envelope as the dashboard's own 404s.
    const res: RunDetailResponse = detail;
    return c.json(res);
  });

  /* ----------------------------------------------------- schedules */
  app.get('/schedules', async (c) => {
    // Schedules are namespace-scoped rows: one schedule per task per
    // (project_id, env), and the dashboard reads the window it is pointed at.
    const ns = namespaceFromQuery(c);
    const rows = await pool.query<{
      id: string;
      task_id: string;
      cron_pattern: string;
      cron_tz: string | null;
      enabled: boolean;
      next_run_at: Date | null;
      last_run_at: Date | null;
      last_run_status: string | null;
    }>(
      `SELECT s.id, s.task_id, s.cron_pattern, s.cron_tz, s.enabled,
              s.next_run_at, s.last_run_at, r.status AS last_run_status
         FROM schedules s
         LEFT JOIN runs r ON r.id = s.last_run_id
                        AND r.project_id = s.project_id AND r.env = s.env
        WHERE s.project_id = $1 AND s.env = $2
        ORDER BY s.task_id ASC`,
      [ns.projectId, ns.env],
    );
    const schedules: ScheduleSummary[] = rows.rows.map((s) => ({
      id: s.id,
      taskId: s.task_id,
      cronPattern: s.cron_pattern,
      cronTz: s.cron_tz,
      enabled: s.enabled,
      nextRunAt: iso(s.next_run_at),
      lastRunAt: iso(s.last_run_at),
      lastRunStatus: (s.last_run_status as ScheduleSummary['lastRunStatus']) ?? null,
    }));
    const res: SchedulesResponse = { schedules };
    return c.json(res);
  });

  app.patch('/schedules/:id', async (c) => {
    const id = c.req.param('id');
    // Scoped like the reads above: an id from another namespace is not found,
    // never silently edited.
    const ns = namespaceFromQuery(c);
    const body = await safeJson<Partial<UpdateScheduleRequest>>(c);
    // enabled is NOT NULL in schedules; validate before any query so a bad body
    // costs nothing and cannot reach the UPDATE as NULL.
    const enabled = requireBoolean(body.enabled, 'enabled');

    const existing = await pool.query<{ cron_pattern: string; cron_tz: string | null }>(
      `SELECT cron_pattern, cron_tz FROM schedules
        WHERE id = $1 AND project_id = $2 AND env = $3`,
      [id, ns.projectId, ns.env],
    );
    const sched = existing.rows[0];
    if (!sched) return c.json({ error: { code: 'not_found', message: 'schedule not found' } }, 404);

    const nextRunAt = enabled
      ? nextCronAt(sched.cron_pattern, sched.cron_tz ?? undefined)
      : null;

    // p1-09: next_run_at is judged by the DB clock, so the re-enabled schedule
    // is clamped to at least 1s after now() — a skewed daemon clock computing
    // nextCronAt here must not seed a value the DB reads as already due (a
    // single spurious fire on enable). The NULL guard keeps an impossible
    // pattern silent instead of firing every tick.
    await pool.query(
      `UPDATE schedules SET enabled = $2,
         next_run_at = CASE
           WHEN $3::timestamptz IS NULL THEN NULL
           ELSE GREATEST($3::timestamptz, now() + interval '1 second')
         END,
         updated_at = now()
        WHERE id = $1 AND project_id = $4 AND env = $5`,
      [id, enabled, nextRunAt, ns.projectId, ns.env],
    );
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  /* ------------------------------------------------------- workers */
  /**
   * The workers table is an append-only history: registerWorker inserts a new
   * row per process start (every `bun --watch` reload is one), and going
   * offline only flips `status`. This route used to serialize all of it, every
   * poll, unbounded (todos/02-performance.md PF6).
   *
   * So: online only by default, and a LIMIT that always applies. "Which
   * daemons are running right now" is the question the workers page asks, and
   * yesterday's dead processes are not part of the answer — `?status=offline`
   * / `?status=all` are there for when they are. Retention (`prune`, or the GC
   * loop) is what removes them for good; this only stops the reader from
   * paying for them.
   */
  app.get('/workers', async (c) => {
    const status = c.req.query('status') ?? 'online';
    if (status !== 'online' && status !== 'offline' && status !== 'all') {
      throw new KernelError('bad_request', 'status must be online, offline or all');
    }
    const limit = intQuery(c, 'limit', { min: 1, max: 200, fallback: 50 });
    // Workers are namespace rows too — a dashboard pointed at default/prod
    // lists the daemons serving default/prod, not the whole fleet.
    const ns = namespaceFromQuery(c);

    const params: unknown[] = [];
    const clauses: string[] = [];
    if (status !== 'all') {
      params.push(status);
      clauses.push(`status = $${params.length}`);
    }
    params.push(ns.projectId, ns.env);
    const nsParam = params.length - 1;
    clauses.push(`project_id = $${nsParam} AND env = $${nsParam + 1}`);
    params.push(limit);
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = await pool.query<{
      id: string;
      name: string | null;
      code_version: string;
      runtime: string;
      tasks: unknown;
      concurrency: number;
      status: string;
      started_at: Date;
      last_heartbeat_at: Date;
    }>(
      `SELECT id, name, code_version, runtime, tasks, concurrency, status,
              started_at, last_heartbeat_at
         FROM workers
         ${whereSql}
        ORDER BY started_at DESC
        LIMIT $${params.length}`,
      params,
    );
    const workers: WorkerSummary[] = rows.rows.map((w) => ({
      id: w.id,
      name: w.name,
      codeVersion: w.code_version,
      runtime: w.runtime,
      tasks: workerTaskIds(w.tasks),
      concurrency: w.concurrency,
      status: w.status === 'offline' ? 'offline' : 'online',
      startedAt: w.started_at.toISOString(),
      lastHeartbeatAt: w.last_heartbeat_at.toISOString(),
    }));
    const res: WorkersResponse = { workers };
    return c.json(res);
  });

  return app;
}
