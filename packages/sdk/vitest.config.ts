import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only *.test.ts — the default `test` run stays DB-free.
    include: ['test/**/*.test.ts'],
  },
});
