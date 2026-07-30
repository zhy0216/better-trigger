/* =============================================================================
   Better Trigger — server JSON → dashboard view-model adapters (pure functions).
   Maps the /api/v1 response shapes (api/client.ts) onto the existing UI types
   in src/types.ts. All status / duration / relative-time formatting lives here
   so screens stay presentation-only.
   ============================================================================= */
import type { StepKind } from '@better-trigger/core';
import type {
  Task,
  Run,
  RunStatus,
  Trace,
  Span,
  SpanKind,
  LogLine,
  Schedule,
} from '../types';
import type {
  TaskSummary,
  RunSummary,
  RunDetailResponse,
  RunStep,
  RunWait,
  RunLog,
  ScheduleSummary,
  ServerRunStatus,
} from './client';

/* ---- status mapping (contract §7) ---------------------------------------- */
// completed→success, waiting→frozen, canceled→canceled; queued/running/failed pass through.
const STATUS_MAP: Record<ServerRunStatus, RunStatus> = {
  queued: 'queued',
  running: 'running',
  waiting: 'frozen',
  completed: 'success',
  failed: 'failed',
  canceled: 'canceled',
};

export function mapStatus(s: ServerRunStatus): RunStatus {
  return STATUS_MAP[s] ?? 'queued';
}

/* ---- formatting helpers -------------------------------------------------- */
/** 640 → "640ms", 2100 → "2.1s" (matches RunView fmtMs). */
export function fmtDuration(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
}

function fmtDurationStr(ms: number | null | undefined): string {
  return fmtDuration(ms) ?? '—';
}

/** ISO timestamp → "just now" / "3m ago" / "2h ago" / "4d ago". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

/** ISO timestamp in the future → "in 6m" / "in 1h 12m" / "in 2d 14h". */
export function relativeFuture(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const diff = then - now;
  if (diff <= 0) return 'due';
  const totalMin = Math.floor(diff / 60000);
  if (totalMin < 1) return 'in <1m';
  if (totalMin < 60) return 'in ' + totalMin + 'm';
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin % 60;
    return 'in ' + totalHr + 'h' + (m ? ' ' + m + 'm' : '');
  }
  const d = Math.floor(totalHr / 24);
  const h = totalHr % 24;
  return 'in ' + d + 'd' + (h ? ' ' + h + 'h' : '');
}

function parseTs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/* ---- tasks (TaskSummary → Task) ------------------------------------------ */
export function adaptTask(t: TaskSummary): Task {
  return {
    id: t.id,
    name: t.name,
    file: t.filePath ?? '',
    runs24h: t.runs24h,
    p50: fmtDurationStr(t.p50Ms),
    p95: fmtDurationStr(t.p95Ms),
    success: t.successRate ?? 0,
    trend: Array.isArray(t.trend) ? t.trend : [],
  };
}

export function adaptTasks(tasks: TaskSummary[]): Task[] {
  return tasks.map(adaptTask);
}

/* ---- runs (RunSummary → Run) --------------------------------------------- */
export function adaptRun(r: RunSummary, now: number = Date.now()): Run {
  const status = mapStatus(r.status);
  const startedSource = r.startedAt ?? r.createdAt;
  return {
    id: r.id,
    task: r.taskId,
    status,
    version: r.codeVersion ?? '—',
    env: r.env,
    trigger: r.trigger,
    duration: fmtDuration(r.durationMs),
    attempts: r.attempt,
    started: relativeTime(startedSource, now),
    ts: parseTs(startedSource) ?? now,
  };
}

export function adaptRuns(runs: RunSummary[], now: number = Date.now()): Run[] {
  return runs.map((r) => adaptRun(r, now));
}

/* ---- run detail (RunDetailResponse → Trace + per-span logs) --------------- */

/*
 * step kind → span kind, exhaustive over core's `StepKind`: `null` marks the
 * deterministic stand-ins, which are not shown as spans (contract §7). Adding a
 * step kind in core breaks this literal until it has been classified, so a new
 * kind cannot silently appear as (or vanish from) the waterfall.
 */
const STEP_SPAN_KIND: Record<StepKind, SpanKind | null> = {
  step: 'fn',
  wait: 'fn',
  'trigger-and-wait': 'task',
  'batch-trigger': 'task',
  now: null,
  random: null,
  uuid: null,
};

/** A kind an older dashboard has never heard of stays visible, as a plain fn span. */
function isHiddenStepKind(kind: StepKind): boolean {
  return STEP_SPAN_KIND[kind] === null;
}

function stepSpanStatus(st: RunStep): RunStatus {
  return st.status === 'failed' ? 'failed' : 'success';
}

export interface AdaptedRunDetail {
  trace: Trace;
  spanLogs: Record<string, LogLine[]>;
  /** the mapped run status, for the header/badge. */
  status: RunStatus;
  /** wake conditions for a waiting (frozen) run, for the inspector. */
  pendingWaits: Array<{ kind: string; resumeAt: string | null; childRunId: string | null }>;
}

/**
 * Build a Trace from a run detail:
 *  - t0 = min(run.startedAt, all steps[].startedAt)
 *  - root span = the run itself (kind 'task', level 0)
 *  - each visible step/wait = one level-1 span
 *      step → 'fn'; wait → 'fn' with "wait " label prefix; trigger-and-wait → 'task'
 *      now/random/uuid → not shown
 *  - logs grouped to spans by stepSeq; stepSeq null → root (s0)
 */
export function adaptRunDetail(detail: RunDetailResponse, now: number = Date.now()): AdaptedRunDetail {
  const { run, steps, waits, logs } = detail;
  const status = mapStatus(run.status);

  // ---- t0: earliest of run.startedAt and every step's startedAt ----
  const candidates: number[] = [];
  const runStart = parseTs(run.startedAt);
  if (runStart != null) candidates.push(runStart);
  steps.forEach((st) => {
    const t = parseTs(st.startedAt);
    if (t != null) candidates.push(t);
  });
  const t0 = candidates.length ? Math.min(...candidates) : (parseTs(run.createdAt) ?? now);

  // ---- visible steps → level-1 spans, keyed by seq for log grouping ----
  const visibleSteps = steps.filter((st) => !isHiddenStepKind(st.kind));
  const seqToSpanId = new Map<number, string>();
  const spans: Span[] = [];

  // root span (the run) — id s0; running runs grow to "now".
  const runEnd = parseTs(run.finishedAt) ?? (status === 'running' || status === 'frozen' ? now : t0);
  const rootDur = Math.max(0, runEnd - t0);

  let maxEnd = rootDur;
  const childSpans: Span[] = [];
  visibleSteps.forEach((st, i) => {
    const id = 's' + (i + 1);
    seqToSpanId.set(st.seq, id);
    const start = (parseTs(st.startedAt) ?? t0) - t0;
    const finish = parseTs(st.finishedAt);
    const running = finish == null;
    // running step grows to now; finished step uses its real span.
    const dur = running ? Math.max(0, now - (t0 + start)) : Math.max(0, finish - t0 - start);
    const kind = STEP_SPAN_KIND[st.kind] ?? 'fn';
    const isWait = st.kind === 'wait';
    const baseLabel = st.label ?? st.kind;
    const label = isWait ? 'wait ' + baseLabel : baseLabel;
    childSpans.push({
      id,
      label,
      kind,
      level: 1,
      start: Math.max(0, start),
      dur,
      status: running ? 'running' : stepSpanStatus(st),
      attempt: String(st.attempt),
      output: st.output,
      error: st.error,
    });
    maxEnd = Math.max(maxEnd, start + dur);
  });

  // For non-terminal runs the timeline endpoint tracks wall-clock `now`, so it
  // would creep every poll and re-layout the whole waterfall. Quantize it up to
  // the next 5s bucket so the axis only widens once per 5s (running span `dur`
  // still uses real `now`, so a single bar still grows smoothly).
  const isTerminal = status !== 'running' && status !== 'frozen';
  const totalMs = isTerminal
    ? Math.max(1, maxEnd)
    : Math.max(1, Math.ceil(maxEnd / 5000) * 5000);
  spans.push({
    id: 's0',
    label: run.taskId,
    kind: 'task',
    level: 0,
    start: 0,
    dur: Math.max(rootDur, totalMs),
    status,
    attempt: run.attempt + (run.maxAttempts != null ? ' of ' + run.maxAttempts : ''),
    output: run.output,
    error: run.error,
  });
  spans.push(...childSpans);

  // ---- per-span logs (logs grouped by stepSeq; null → root s0) ----
  const spanLogs: Record<string, LogLine[]> = {};
  const pushLog = (spanId: string, line: LogLine) => {
    (spanLogs[spanId] ??= []).push(line);
  };
  logs.forEach((lg: RunLog) => {
    const spanId = lg.stepSeq != null ? seqToSpanId.get(lg.stepSeq) ?? 's0' : 's0';
    const at = parseTs(lg.ts);
    const ms = at != null ? Math.max(0, at - t0) : 0;
    pushLog(spanId, [lg.level, lg.message, Math.round(ms) + 'ms']);
  });

  // ---- payload (Record<string, string|number> per types.ts) ----
  const payload = toPayloadRecord(run.payload);

  const queuedFor = queuedDuration(run.queuedAt, run.startedAt);

  const trace: Trace = {
    runId: run.id,
    task: run.taskId,
    version: run.codeVersion ?? '—',
    env: run.env,
    trigger: run.trigger,
    queuedFor,
    payload,
    totalMs,
    spans,
  };

  const pendingWaits = waits
    .filter((w: RunWait) => w.status === 'pending')
    .map((w) => ({ kind: w.kind, resumeAt: w.resumeAt, childRunId: w.childRunId }));

  return { trace, spanLogs, status, pendingWaits };
}

function queuedDuration(queuedAt: string | null, startedAt: string | null): string {
  const q = parseTs(queuedAt);
  const s = parseTs(startedAt);
  if (q == null || s == null) return '—';
  return fmtDurationStr(Math.max(0, s - q));
}

/** Pass the run payload through for the inspector (renders as pretty JSON). */
function toPayloadRecord(payload: unknown): Record<string, unknown> {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

/* ---- schedules (ScheduleSummary → Schedule) ------------------------------ */
export function adaptSchedule(s: ScheduleSummary, now: number = Date.now()): Schedule {
  // Schedules screen renders last: 'ok' | 'warn'; map server lastRunStatus onto that vocabulary.
  let last = '—';
  if (s.lastRunStatus === 'failed' || s.lastRunStatus === 'canceled') last = 'warn';
  else if (s.lastRunStatus != null) last = 'ok';
  return {
    id: s.id,
    task: s.taskId,
    cron: s.cronPattern,
    human: humanCron(s.cronPattern),
    tz: s.cronTz ?? 'UTC',
    next: relativeFuture(s.nextRunAt, now),
    last,
    enabled: s.enabled,
  };
}

export function adaptSchedules(schedules: ScheduleSummary[], now: number = Date.now()): Schedule[] {
  return schedules.map((s) => adaptSchedule(s, now));
}

/** Best-effort human description of common cron patterns; falls back to raw. */
function humanCron(pattern: string): string {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hr, dom, , dow] = parts;
    if (min.startsWith('*/') && hr === '*' && dom === '*' && dow === '*') {
      return 'Every ' + min.slice(2) + ' minutes';
    }
    if (min === '0' && hr.startsWith('*/') && dom === '*' && dow === '*') {
      return 'Every ' + hr.slice(2) + ' hours';
    }
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && dow === '*') {
      return 'Daily at ' + pad2(hr) + ':' + pad2(min);
    }
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && /^[0-7]$/.test(dow)) {
      return 'Every ' + DAYS[Number(dow) % 7] + ' at ' + pad2(hr) + ':' + pad2(min);
    }
  }
  return pattern;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function pad2(s: string): string {
  return s.length < 2 ? '0' + s : s;
}
