-- Referential integrity + state constraints (C5, todos/01-correctness.md).
-- queue.run_id / waits.run_id / waits.child_run_id / runs.parent_run_id and
-- the schedules→tasks relation become real foreign keys, and status/kind/level
-- become CHECK-constrained closed enums.
--
-- The five cleanups below are NOT cosmetic and must stay ahead of the ALTERs.
-- Until now nothing referenced runs.id from these tables, so any database
-- that ever lost a run row out from under its dependents (a manual psql
-- DELETE, a restored dump, an aborted experiment) is carrying orphans — and
-- `ADD CONSTRAINT ... FOREIGN KEY` validates every existing row. One orphan
-- would fail this migration, and because daemons auto-migrate at boot
-- (apps/worker/src/main.ts), that failure would stop every daemon on that
-- database from starting at all. Cleaning first makes the constraint additions
-- unconditionally satisfiable.
--
-- Strategy per relation:
--   - queue.run_id / waits.run_id: dangling scheduling state for a run that
--     no longer exists — DELETE (they are derived rows, the run is gone).
--   - waits.child_run_id: a parent waiting on a child that no longer exists
--     can never be woken by it. The FK below is ON DELETE SET NULL (not
--     CASCADE — deleting a child must never strand its 'waiting' parent), so
--     the pre-existing orphans are SET NULL too, and the orchestrator's
--     wait-due scanner then fails those parents with a ChildLostError instead
--     of leaving them waiting forever. Deleting the row here would strand
--     them — the exact bug CASCADE causes.
--   - runs.parent_run_id: matches the FK's ON DELETE SET NULL — the child run
--     itself is live and must survive; only its lineage pointer is cleared.
--   - schedules.task_id: a schedule whose task row is gone is a cron
--     registration for a task that is not (and cannot be) served — DELETE
--     (registration inserts task and schedule in the same transaction, so a
--     healthy database has none of these).
-- On a healthy database all five affect 0 rows.
--
-- The CHECK constraints below assume the existing status/kind/level values
-- are ALREADY inside their legal sets — every value this engine has ever
-- written is, so a database migrated by the engine itself needs no data
-- fixes. But a database that was hand-written (or hand-edited) may carry an
-- out-of-set value, and then `ADD CONSTRAINT ... CHECK` FAILS the whole
-- migration, which stops every daemon from booting (daemons auto-migrate at
-- startup). There is deliberately no automatic cleanup for that case: which
-- out-of-set value means which state is a judgment call, and guessing would
-- corrupt data. If this migration fails on a CHECK, inspect and fix the rows
-- first, e.g.:
--   SELECT id, status FROM runs WHERE status NOT IN
--     ('queued','running','waiting','completed','failed','canceled');
--   UPDATE runs SET status = 'queued' WHERE status NOT IN (...);  -- per row,
--   after deciding what each value actually meant. The same pattern applies
--   to run_steps.kind/status/attempt, waits.kind/status, workers.status and
--   logs.level. (The FK orphan cleanups above DO run automatically — they
--   delete/set-NULL only rows that are dangling by construction.)
DELETE FROM "queue" q WHERE NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = q."run_id");--> statement-breakpoint
DELETE FROM "waits" w WHERE NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = w."run_id");--> statement-breakpoint
UPDATE "waits" SET "child_run_id" = NULL WHERE "child_run_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "waits"."child_run_id");--> statement-breakpoint
UPDATE "runs" SET "parent_run_id" = NULL WHERE "parent_run_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "runs"."parent_run_id");--> statement-breakpoint
DELETE FROM "schedules" s WHERE NOT EXISTS (SELECT 1 FROM "tasks" t WHERE t."project_id" = s."project_id" AND t."env" = s."env" AND t."id" = s."task_id");--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_project_id_env_task_id_tasks_project_id_env_id_fk" FOREIGN KEY ("project_id","env","task_id") REFERENCES "public"."tasks"("project_id","env","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waits" ADD CONSTRAINT "waits_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waits" ADD CONSTRAINT "waits_child_run_id_runs_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_level_check" CHECK ("logs"."level" IN ('debug','info','warn','error'));--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_kind_check" CHECK ("run_steps"."kind" IN ('step','wait','trigger-and-wait','batch-trigger','now','random','uuid'));--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_status_check" CHECK ("run_steps"."status" IN ('completed','failed'));--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_attempt_check" CHECK ("run_steps"."attempt" >= 1);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" IN ('queued','running','waiting','completed','failed','canceled'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_attempt_check" CHECK ("runs"."attempt" >= 1);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_recoveries_check" CHECK ("runs"."recoveries" >= 0 AND "runs"."recoveries" <= "runs"."max_recoveries");--> statement-breakpoint
ALTER TABLE "waits" ADD CONSTRAINT "waits_kind_check" CHECK ("waits"."kind" IN ('duration','until','run'));--> statement-breakpoint
ALTER TABLE "waits" ADD CONSTRAINT "waits_status_check" CHECK ("waits"."status" IN ('pending','completed','canceled'));--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_status_check" CHECK ("workers"."status" IN ('online','offline'));
