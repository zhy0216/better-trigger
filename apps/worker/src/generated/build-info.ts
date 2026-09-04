/* =============================================================================
   @better-trigger/worker — immutable source fallback for build metadata.

   The two private identifiers are replaced by tsdown during `bun run build`.
   Source execution (tests, editors, and consumers that have not built yet)
   uses the version-only fallback below. Keeping this file immutable is
   deliberate: build provenance must never rewrite a tracked task input or
   leave a temporary commit identity behind after a failed/interrupted build.
   ============================================================================= */
declare const __BETTER_TRIGGER_BUILD_VERSION__: string | undefined;
declare const __BETTER_TRIGGER_BUILD_SHA__: string | undefined;

export const BUILD_VERSION =
  typeof __BETTER_TRIGGER_BUILD_VERSION__ === 'string'
    ? __BETTER_TRIGGER_BUILD_VERSION__
    : '0.1.0';
export const BUILD_SHA =
  typeof __BETTER_TRIGGER_BUILD_SHA__ === 'string'
    ? __BETTER_TRIGGER_BUILD_SHA__
    : undefined;
