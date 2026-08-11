/* =============================================================================
   @better-trigger/core — namespace (projectId + env isolation).

   Every run, task, schedule, queue row, wait, step row and log line belongs to
   exactly one namespace: the (projectId, env) pair it was created under. The
   kernel never infers a namespace — every operation carries one explicitly, and
   every SQL statement that touches a business table predicates on it (C2,
   todos/01-correctness.md). Defaults are resolved exactly once, at the host
   boundary (worker config / HTTP request), never inside the kernel.
   ============================================================================= */
import { KernelError } from './kernel-errors';

/** The isolation scope a run / task / schedule / worker lives in. */
export interface Namespace {
  /** Project id, e.g. 'default', 'acme'. */
  projectId: string;
  /** Environment, e.g. 'prod', 'staging', 'dev'. */
  env: string;
}

/**
 * The namespace every pre-namespace row of this database lives in ('default' /
 * 'prod' are the column defaults of migration 0000). Hosts that expose a
 * "no namespace configured" mode resolve to this — once, at their boundary.
 */
export const DEFAULT_NAMESPACE: Namespace = { projectId: 'default', env: 'prod' };

/**
 * Upper bound on projectId/env length. Enforced by assertNamespace.
 */
export const NAMESPACE_PART_MAX_LENGTH = 64;

/**
 * Validate a namespace value. projectId and env must both be non-empty strings
 * of at most NAMESPACE_PART_MAX_LENGTH characters, and neither may contain ':'
 * — the concurrency-limiter advisory lock key is built as
 * `bt:cc:${projectId}:${env}:${key}` (packages/kernel/src/queue.ts), so a ':'
 * in a namespace would make two distinct namespaces produce colliding keys.
 * Throws KernelError('bad_request') on the first violation.
 */
export function assertNamespace(ns: Namespace): void {
  for (const [name, value] of [
    ['projectId', ns?.projectId],
    ['env', ns?.env],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new KernelError('bad_request', `namespace.${name} must be a non-empty string`);
    }
    if (value.length > NAMESPACE_PART_MAX_LENGTH) {
      throw new KernelError(
        'bad_request',
        `namespace.${name} must be at most ${NAMESPACE_PART_MAX_LENGTH} characters`,
      );
    }
    if (value.includes(':')) {
      throw new KernelError(
        'bad_request',
        `namespace.${name} must not contain ':' (it separates the advisory lock key)`,
      );
    }
  }
}
