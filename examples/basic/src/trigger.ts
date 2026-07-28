/* =============================================================================
   @better-trigger/example-basic — the embedded better-trigger instance.

   One instance = one Postgres pool + one kernel. Every entrypoint (worker,
   scripts) imports this shared instance; migrations run automatically before
   the first operation that touches the database.

   Points at DATABASE_URL (default postgres://localhost:5432/better_trigger).
   ============================================================================= */
import { betterTrigger } from 'better-trigger';

export const trigger = betterTrigger({
  database: {
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://localhost:5432/better_trigger',
  },
});
