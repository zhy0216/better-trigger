import { defineConfig } from 'drizzle-kit';
import { DB_SCHEMA, MIGRATIONS_TABLE } from './src/constants';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  migrations: {
    schema: DB_SCHEMA,
    table: MIGRATIONS_TABLE,
  },
});
