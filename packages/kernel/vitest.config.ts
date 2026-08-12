/* =============================================================================
   @better-trigger/kernel — vitest config.
   test/ is the stub suite; test/pg/ is the true-Postgres suite (DATABASE_URL
   gated inside each suite, skipped when unset). The true-PG suites provision a
   database and drive the kernel end to end, which needs more than the default
   5s per test — the timeout is raised globally so the gate is not the suite's
   own clock.
   ============================================================================= */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
