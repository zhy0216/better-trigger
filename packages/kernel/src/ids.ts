/* =============================================================================
   @better-trigger/kernel — prefixed id generation.
   Random ids: a prefix + a hex token derived from crypto.randomUUID() (dashes
   stripped, truncated). e.g. run_3f9c1a2b4d5e6f70
   ============================================================================= */
import { randomUUID } from 'node:crypto';

function token(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
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
