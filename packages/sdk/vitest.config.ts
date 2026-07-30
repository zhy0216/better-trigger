import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only *.test.ts. test/lifecycle-selftest.ts is a pre-split bun script that
    // needs a live Postgres and predates the client/daemon split — it must stay
    // out of the DB-free default `test` run.
    include: ['test/**/*.test.ts'],
  },
});
