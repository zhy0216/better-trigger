/* =============================================================================
   Better Trigger — dashboard view-model types.
   These are presentation shapes (pre-formatted strings, waterfall spans), not
   the wire contract: the server JSON shapes come from @better-trigger/core via
   api/client.ts, and api/adapter.ts maps one onto the other.
   ============================================================================= */
import type { SerializedError } from '@better-trigger/core';

/**
 * UI status vocabulary — deliberately not core's `RunStatus`: it adds 'warning'
 * (no server equivalent) and renames the server states the badges care about
 * (completed→success, waiting→frozen). adapter.ts owns the mapping.
 */
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

/** Same shape the server stores in runs.error / run_steps.error. */
export type SpanError = SerializedError;

export interface Span {
  id: string;
  label: string;
  kind: SpanKind;
  level: number;
  start: number;
  dur: number;
  status: RunStatus;
  /** formatted attempt, e.g. "2 of 3" (run) or "1" (step); absent when unknown. */
  attempt?: string;
  /** real run/step output from the server, shown in the inspector. */
  output?: unknown;
  /** real run/step error from the server. */
  error?: SpanError | null;
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

export type Route =
  | 'run'
  | 'runs'
  | 'tasks'
  | 'schedules'
  | 'alerts'
  | 'deployments'
  | 'onboarding';

export type VizStyle = 'waterfall' | 'tree';
