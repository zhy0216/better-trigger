-- Retention cascades (todos/02-performance.md PF6): logs / run_steps follow
-- their run into the grave, so pruning is "DELETE FROM runs" and nothing else.
--
-- The two DELETEs below are NOT cosmetic and must stay ahead of the ALTERs.
-- Until now nothing referenced runs.id, so any database that ever lost a run
-- row out from under its dependent rows (a manual psql DELETE, a restored dump,
-- an aborted experiment) is carrying orphans — and `ADD CONSTRAINT ... FOREIGN
-- KEY` validates every existing row. One orphaned log line would fail this
-- migration, and because daemons auto-migrate at boot (apps/worker/src/main.ts),
-- that failure would stop every daemon on that database from starting at all.
-- Cleaning first makes the constraint additions unconditionally satisfiable.
-- On a healthy database both DELETEs affect 0 rows.
DELETE FROM "logs" l WHERE NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = l."run_id");--> statement-breakpoint
DELETE FROM "run_steps" s WHERE NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = s."run_id");--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
