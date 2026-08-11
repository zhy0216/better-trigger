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
import type { StepKind } from '@better-trigger/core';

/** Short sha256 of a function's source. Native/bound fns hash their
 *  placeholder source ("[native code]") — stable, just not discriminating.
 *  Same algorithm the worker uses for task code versions (runtime.ts). */
export function fnSourceHash(fn: unknown): string {
  const source = typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn);
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

interface JsonObject {
  toJSON?: () => unknown;
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively, so two
 * objects that differ only in key order serialize identically (payloads that
 * round-trip through jsonb come back with Postgres' own key order). Matches
 * JSON.stringify's value semantics — undefined/function members are dropped in
 * objects and become null in arrays; Date-like values go through toJSON first.
 * Circular references are rejected (JSON.stringify would also throw on them,
 * and a payload that reached the ledger has already survived JSON.stringify).
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet()));
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  // BigInt has no JSON spelling (JSON.stringify throws on it). Hash a stable
  // marker instead so two computations of the same value agree — the payload
  // itself will be refused by createRunIn's serialization check anyway, so no
  // fingerprint that matters is ever compared across a stored value.
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  if (value === null || typeof value !== 'object') return value;
  if (typeof (value as JsonObject).toJSON === 'function') {
    return canonicalize((value as JsonObject).toJSON?.(), seen);
  }
  if (seen.has(value)) {
    throw new TypeError('cannot canonicalize a circular structure');
  }
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) =>
      v === undefined || typeof v === 'function' ? null : canonicalize(v, seen),
    );
  } else {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || typeof v === 'function') continue;
      record[key] = canonicalize(v, seen);
    }
    out = record;
  }
  seen.delete(value);
  return out;
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
