/* =============================================================================
   Better Trigger — shared domain types.
   ============================================================================= */

export type RunStatus =
  | 'running'
  | 'queued'
  | 'success'
  | 'warning'
  | 'failed'
  | 'frozen'
  | 'canceled';

export type SpanKind = 'task' | 'http' | 'query' | 'fn';

export interface Task {
  id: string;
  name: string;
  file: string;
  runs24h: number;
  p50: string;
  p95: string;
  success: number;
  trend: number[];
}

export interface Run {
  id: string;
  task: string;
  status: RunStatus;
  version: string;
  env: string;
  trigger: string;
  duration: string | null;
  attempts: number;
  started: string;
  ts: number;
}

export interface Span {
  id: string;
  label: string;
  kind: SpanKind;
  level: number;
  start: number;
  dur: number;
  status: RunStatus;
}

export interface Trace {
  runId: string;
  task: string;
  version: string;
  env: string;
  trigger: string;
  queuedFor: string;
  payload: Record<string, unknown>;
  totalMs: number;
  spans: Span[];
}

/** [level, message, timestamp] */
export type LogLine = [string, string, string];

export interface Schedule {
  id: string;
  task: string;
  cron: string;
  human: string;
  tz: string;
  next: string;
  last: string;
  enabled: boolean;
}

export interface Alert {
  id: string;
  title: string;
  scope: string;
  channel: string;
  status: 'firing' | 'armed' | 'resolved';
  when: string;
  tone: string;
}

export interface Deployment {
  id: string;
  env: string;
  status: 'current' | 'previous' | 'archived' | 'failed';
  tasks: number;
  when: string;
  git: string;
  by: string;
  msg: string;
}

export type Route =
  | 'run'
  | 'runs'
  | 'tasks'
  | 'schedules'
  | 'alerts'
  | 'deployments'
  | 'onboarding';

export type VizStyle = 'waterfall' | 'tree';
