/* =============================================================================
   better-trigger — shared concurrency-key derivation.

   Both the TaskHandle trigger paths (task.ts) and the instance-level trigger
   (instance.ts) merge a task's derived concurrency key into the trigger options,
   with an explicit `options.concurrencyKey` always winning. They used to carry
   the same two-line logic independently (01-core-sdk T10) — one helper keeps the
   instance and handle paths from drifting. Lives in its own module so neither
   task.ts nor instance.ts has to import the other at runtime just to share it.
   ============================================================================= */
import type { TriggerOptions } from '@better-trigger/core';

/**
 * Return `options` with `concurrencyKey` set to the explicit option when one was
 * given, else the `derivedKey` (from a task's `concurrency.key(payload)`). When
 * neither exists the options are returned untouched, so a bare trigger keeps a
 * bare (undefined) options object rather than gaining an empty `{}`.
 */
export function applyConcurrencyKey(
  options: TriggerOptions | undefined,
  derivedKey: string | undefined,
): TriggerOptions | undefined {
  const key = options?.concurrencyKey ?? derivedKey;
  if (key === undefined) return options;
  return { ...options, concurrencyKey: key };
}
