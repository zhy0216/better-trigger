/* =============================================================================
   @better-trigger/server — prefixed id generation.
   Random ids: a prefix + a hex token derived from crypto.randomUUID() (dashes
   stripped, truncated). e.g. run_3f9c1a2b4d5e6f70
   ============================================================================= */
import { randomUUID } from 'node:crypto';

function token(len = 24): string {
  // Two UUIDs give 64 hex chars; plenty for any truncation length.
  const hex = (randomUUID() + randomUUID()).replace(/-/g, '');
  return hex.slice(0, len);
}

export function runId(): string {
  return `run_${token()}`;
}

export function scheduleId(): string {
  return `sch_${token()}`;
}

export function workerId(): string {
  return `wkr_${token()}`;
}
