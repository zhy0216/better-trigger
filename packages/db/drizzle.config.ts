import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  // Only needed by `drizzle-kit migrate` / `drizzle-kit studio`;
  // `drizzle-kit generate` works offline.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/better_trigger',
  },
});
