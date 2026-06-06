/* =============================================================================
   @better-trigger/server — dashboard read API.
   GET /health · /tasks · /runs · /runs/:id · /schedules · PATCH /schedules/:id
   · GET /workers. See docs/backend-contract.md §5.
   ============================================================================= */
import { Hono } from 'hono';
import type {
  HealthResponse,
  LogRow,
  RunDetail,
  RunDetailResponse,
  RunStepRow,
  RunsResponse,
  RunSummary,
  ScheduleSummary,
  SchedulesResponse,
  TaskSummary,
  TasksResponse,
  UpdateScheduleRequest,
  WaitRow,
  WorkerSummary,
  WorkersResponse,
} from '@better-trigger/core';
import { pool } from '../db/index';
import { computeTaskStats } from '../engine/stats';
import { nextCronAt } from '../engine/orchestrator';

const VERSION = '0.1.0';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const durationMs = (started: Date | null, finished: Date | null): number | null =>
  started && finished ? finished.getTime() - started.getTime() : null;

export function dashboardRoutes(): Hono {
  const app = new Hono();

  /* -------------------------------------------------------- health */
  app.get('/health', (c) => {
    const res: HealthResponse = { ok: true, version: VERSION };
    return c.json(res);
  });

  /* --------------------------------------------------------- tasks */
  app.get('/tasks', async (c) => {
    const taskRows = await pool.query<{
      id: string;
      name: string;
      file_path: string | null;
      trigger_source: string;
      cron_pattern: string | null;
    }>(
      `SELECT id, name, file_path, trigger_source, cron_pattern FROM tasks ORDER BY name ASC`,
    );
    const stats = await computeTaskStats();

    const tasks: TaskSummary[] = taskRows.rows.map((t) => {
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
    const res: TasksResponse = { tasks };
    return c.json(res);
  });

  /* ---------------------------------------------------------- runs */
  app.get('/runs', async (c) => {
    const env = c.req.query('env');
    const taskId = c.req.query('taskId');
    const status = c.req.query('status');
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const cursor = c.req.query('cursor');

    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    if (env) add('env = $?', env);
    if (taskId) add('task_id = $?', taskId);
    if (status) add('status = $?', status);

    // Keyset cursor = "<createdAtIso>|<id>"; page strictly older.
    if (cursor) {
      const sep = cursor.lastIndexOf('|');
      if (sep > 0) {
        const cAt = cursor.slice(0, sep);
        const cId = cursor.slice(sep + 1);
        params.push(cAt);
        const p1 = params.length;
        params.push(cId);
        const p2 = params.length;
        where.push(`(created_at < $${p1} OR (created_at = $${p1} AND id < $${p2}))`);
      }
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
    const runRes = await pool.query<{
      id: string;
      task_id: string;
      status: string;
      trigger_type: string;
      code_version: string | null;
      env: string;
      attempt: number;
      max_attempts: number;
      payload: unknown;
      output: unknown;
      error: unknown;
      parent_run_id: string | null;
      idempotency_key: string | null;
      queued_at: Date | null;
      created_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
    }>(
      `SELECT id, task_id, status, trigger_type, code_version, env, attempt, max_attempts,
              payload, output, error, parent_run_id, idempotency_key,
              queued_at, created_at, started_at, finished_at
         FROM runs WHERE id = $1`,
      [id],
    );
    const r = runRes.rows[0];
    if (!r) return c.json({ error: { code: 'not_found', message: 'run not found' } }, 404);

    const run: RunDetail = {
      id: r.id,
      taskId: r.task_id,
      status: r.status as RunDetail['status'],
      trigger: r.trigger_type as RunDetail['trigger'],
      codeVersion: r.code_version,
      env: r.env,
      attempt: r.attempt,
      durationMs: durationMs(r.started_at, r.finished_at),
      createdAt: r.created_at.toISOString(),
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      payload: r.payload,
      output: r.output,
      error: (r.error as RunDetail['error']) ?? null,
      parentRunId: r.parent_run_id,
      idempotencyKey: r.idempotency_key,
      maxAttempts: r.max_attempts,
      queuedAt: iso(r.queued_at),
    };

    const stepsRes = await pool.query<{
      seq: number;
      kind: string;
      label: string | null;
      status: string;
      output: unknown;
      error: unknown;
      attempt: number;
      started_at: Date | null;
      finished_at: Date | null;
    }>(
      `SELECT seq, kind, label, status, output, error, attempt, started_at, finished_at
         FROM run_steps WHERE run_id = $1 ORDER BY seq ASC`,
      [id],
    );
    const steps: RunStepRow[] = stepsRes.rows.map((s) => ({
      seq: s.seq,
      kind: s.kind as RunStepRow['kind'],
      label: s.label,
      status: s.status as RunStepRow['status'],
      output: s.output,
      error: (s.error as RunStepRow['error']) ?? null,
      attempt: s.attempt,
      startedAt: iso(s.started_at),
      finishedAt: iso(s.finished_at),
    }));

    const waitsRes = await pool.query<{
      id: number;
      step_seq: number;
      kind: string;
      resume_at: Date | null;
      child_run_id: string | null;
      status: string;
    }>(
      `SELECT id, step_seq, kind, resume_at, child_run_id, status
         FROM waits WHERE run_id = $1 ORDER BY id ASC`,
      [id],
    );
    const waitRows: WaitRow[] = waitsRes.rows.map((w) => ({
      id: Number(w.id),
      stepSeq: w.step_seq,
      kind: w.kind as WaitRow['kind'],
      resumeAt: iso(w.resume_at),
      childRunId: w.child_run_id,
      status: w.status as WaitRow['status'],
    }));

    const logsRes = await pool.query<{
      id: number;
      step_seq: number | null;
      level: string;
      message: string;
      data: unknown;
      ts: Date;
    }>(
      `SELECT id, step_seq, level, message, data, ts
         FROM logs WHERE run_id = $1 ORDER BY id ASC LIMIT 1000`,
      [id],
    );
    const logRows: LogRow[] = logsRes.rows.map((l) => ({
      id: Number(l.id),
      stepSeq: l.step_seq,
      level: l.level as LogRow['level'],
      message: l.message,
      data: l.data,
      ts: l.ts.toISOString(),
    }));

    const res: RunDetailResponse = { run, steps, waits: waitRows, logs: logRows };
    return c.json(res);
  });

  /* ----------------------------------------------------- schedules */
  app.get('/schedules', async (c) => {
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
        ORDER BY s.task_id ASC`,
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
    const body = await c.req.json<UpdateScheduleRequest>();

    const existing = await pool.query<{ cron_pattern: string; cron_tz: string | null }>(
      `SELECT cron_pattern, cron_tz FROM schedules WHERE id = $1`,
      [id],
    );
    const sched = existing.rows[0];
    if (!sched) return c.json({ error: { code: 'not_found', message: 'schedule not found' } }, 404);

    const nextRunAt = body.enabled
      ? nextCronAt(sched.cron_pattern, sched.cron_tz ?? undefined)
      : null;

    await pool.query(
      `UPDATE schedules SET enabled = $2, next_run_at = $3, updated_at = now() WHERE id = $1`,
      [id, body.enabled, nextRunAt],
    );
    const res: OkResponseLike = { ok: true };
    return c.json(res);
  });

  /* ------------------------------------------------------- workers */
  app.get('/workers', async (c) => {
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
         FROM workers ORDER BY started_at DESC`,
    );
    const workers: WorkerSummary[] = rows.rows.map((w) => ({
      id: w.id,
      name: w.name,
      codeVersion: w.code_version,
      runtime: w.runtime,
      tasks: (w.tasks as string[] | null) ?? [],
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

interface OkResponseLike {
  ok: true;
}
