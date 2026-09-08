/* =============================================================================
   @better-trigger/kernel — stable replay fingerprints for durable steps (C1).
   Single home for the fingerprint algorithm so every writer of a run_steps row
   (the executor, suspendRun, the wait-due orchestrator, wakeParentIfWaiting,
   batchTriggerChild) computes byte-identical values for the same call site.

   Canonical form: sha256 of canonicalStringify({ v, kind, label, input, code }).
   `v` is the format version — bumping it changes every fingerprint, which is
   exactly what a format change requires (old and new values must never match).
   `code` is the RUN's code version (runs.code_version), the version that wrote
   the ledger — not the process's current version, so a redeploy that changes
   nothing about a step does not drift its in-flight ledgers, while a semantic
   change to the step's inputs (fn source, payloads, resumeAt) always does.

   Values are canonicalized (object keys sorted recursively) BEFORE hashing:
   fingerprints must not depend on key insertion order. That matters twice —
   a trigger payload that goes through jsonb comes back with Postgres' own key
   order, and two spellings of the same object must not drift a ledger.
   ============================================================================= */
import { createHash } from 'node:crypto';
import { canonicalStringify as stringifyJson, type StepKind } from '@better-trigger/core';

/** Short sha256 of a function's source. Native/bound fns hash their
 *  placeholder source ("[native code]") — stable, just not discriminating.
 *  Same algorithm the worker uses for task code versions (runtime.ts). */
export function fnSourceHash(fn: unknown): string {
  const source = typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn);
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/**
 * Use the storage serializer's JSON semantics and canonical bytes. Unlike
 * core's JSON.stringify-shaped API, a fingerprint requires a string: reject
 * roots without a JSON spelling as well as BigInt, cycles and throwing hooks.
 * BigInt no longer hashes an invented marker; it was never a valid payload.
 *
 * Ordinary v1 inputs keep their bytes. Previously misrepresented special keys,
 * boxed primitives and toJSON results can change fingerprints: compare against
 * the old ledger and report drift, never rewrite it or bump every run's v1.
 */
export function canonicalStringify(value: unknown): string {
  const json = stringifyJson(value);
  if (json === undefined) {
    throw new TypeError('fingerprint input has no JSON representation');
  }
  return json;
}

export interface StepFingerprintArgs {
  kind: StepKind;
  /** NULL exactly where the ledger row's label is NULL (waits, triggerAndWait). */
  label: string | null;
  /** JSON-serializable inputs of the primitive: fn source hash for ctx.step,
   *  the declared duration / until instant for waits, taskId + payload +
   *  options for triggerAndWait, items for batchTrigger, {} for the
   *  deterministic substitutes. */
  input: unknown;
  /** The run's code version (runs.code_version) — the ledger writer's identity. */
  codeVersion: string | null;
}

export function stepFingerprint(args: StepFingerprintArgs): string {
  const canonical = canonicalStringify({
    v: 1,
    kind: args.kind,
    label: args.label ?? null,
    input: args.input ?? null,
    code: args.codeVersion ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
