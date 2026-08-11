/* =============================================================================
   @better-trigger/worker — namespace resolution at the host boundary.

   The kernel never infers a namespace (C2, packages/core/src/namespace.ts):
   every operation carries one, and defaults are resolved exactly once, where
   the host meets the caller — a trigger request, a dashboard read, the CLI.
   These two helpers are that boundary.

   - namespaceFromOptions: the namespace a trigger / batchTrigger request runs
     in. The run's projectId/env come from the request body's `options` and
     default to 'default'/'prod' — the namespace every pre-namespace row lives
     in. An invalid pair surfaces as KernelError('bad_request') → 400.
   - namespaceFromQuery: the namespace a read / control request targets, from
     `?projectId=` / `?env=` query params (same defaults). Used by the runs
     routes (which the SDK drives) and the dashboard routes — the "single
     namespace by default" visibility boundary: without params a request only
     ever sees default/prod.
   ============================================================================= */
import { assertNamespace, DEFAULT_NAMESPACE, type Namespace } from '@better-trigger/core';
import type { Context } from 'hono';
import type { TriggerOptions } from '@better-trigger/core';

/**
 * Resolve the namespace a trigger request creates its run(s) in. The host
 * resolves the pair once, here, before the kernel sees it — the kernel's
 * assertNamespace is the backstop, not the resolver.
 */
export function namespaceFromOptions(options: TriggerOptions | undefined): Namespace {
  const ns: Namespace = {
    projectId: options?.projectId ?? DEFAULT_NAMESPACE.projectId,
    env: options?.env ?? DEFAULT_NAMESPACE.env,
  };
  assertNamespace(ns);
  return ns;
}

/**
 * Resolve the namespace a request targets from its query string. Absent params
 * resolve to default/prod — a caller that says nothing sees (and mutates) only
 * the default namespace, never every namespace at once.
 */
export function namespaceFromQuery(c: Context): Namespace {
  const ns: Namespace = {
    projectId: c.req.query('projectId') ?? DEFAULT_NAMESPACE.projectId,
    env: c.req.query('env') ?? DEFAULT_NAMESPACE.env,
  };
  assertNamespace(ns);
  return ns;
}
