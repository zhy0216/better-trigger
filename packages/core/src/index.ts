/* =============================================================================
   @better-trigger/core — shared, transport-neutral surface.
   ZERO runtime dependencies by design: this package is on the SDK's dependency
   path, so anything requiring `pg` (the kernel) lives in @better-trigger/kernel
   instead. Keep it that way.
   ============================================================================= */
export * from './types';
export * from './namespace';
export * from './errors';
export * from './duration';
export * from './backoff';
export * from './kernel-errors';
export * from './result-timeout-error';
export * from './serialize';
