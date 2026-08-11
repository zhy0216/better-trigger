-- C2 namespace isolation (todos/01-correctness.md): every unique key and
-- secondary index gains the (project_id, env) prefix, and workers gain a
-- `namespaces` jsonb column declaring which namespaces they serve.
--
-- All pre-existing rows carry the column defaults ('default', 'prod'), and
-- each new unique key is a strict superset of the constraint it replaces
-- (old unique ⇒ new unique), so no rebuild below can collide — the drops are
-- paired with their creates inside this single transaction purely for
-- reviewability; the migrator rolls everything back if any statement fails.
--> statement-breakpoint
-- tasks PK: id → (project_id, env, id)
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_pkey";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_env_id_pk" PRIMARY KEY("project_id","env","id");--> statement-breakpoint
-- schedules unique: task_id → (project_id, env, task_id). The old constraint
-- is dropped first because a constraint and its backing index share the name
-- space; the new unique INDEX keeps the same name.
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_task_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_task_id_unique" ON "schedules" USING btree ("project_id","env","task_id");--> statement-breakpoint
-- runs idempotency unique: (task_id, idempotency_key) → (project_id, env,
-- task_id, idempotency_key), partial predicate unchanged.
DROP INDEX "runs_task_idempotency_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_task_idempotency_uniq" ON "runs" USING btree ("project_id","env","task_id","idempotency_key") WHERE "runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
DROP INDEX "logs_run_id_idx";--> statement-breakpoint
DROP INDEX "queue_available_priority_idx";--> statement-breakpoint
DROP INDEX "queue_concurrency_idx";--> statement-breakpoint
DROP INDEX "queue_lease_until_idx";--> statement-breakpoint
DROP INDEX "queue_claimable_idx";--> statement-breakpoint
DROP INDEX "runs_task_created_idx";--> statement-breakpoint
DROP INDEX "runs_status_concurrency_idx";--> statement-breakpoint
DROP INDEX "runs_created_idx";--> statement-breakpoint
DROP INDEX "waits_status_resume_idx";--> statement-breakpoint
DROP INDEX "waits_child_run_idx";--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "namespaces" jsonb DEFAULT '[{"projectId":"default","env":"prod"}]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "schedules_next_run_idx" ON "schedules" USING btree ("project_id","env","next_run_at");--> statement-breakpoint
CREATE INDEX "logs_run_id_idx" ON "logs" USING btree ("project_id","env","run_id","id");--> statement-breakpoint
CREATE INDEX "queue_available_priority_idx" ON "queue" USING btree ("project_id","env","available_at","priority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "queue_concurrency_idx" ON "queue" USING btree ("project_id","env","concurrency_key");--> statement-breakpoint
CREATE INDEX "queue_lease_until_idx" ON "queue" USING btree ("project_id","env","lease_until") WHERE "queue"."lease_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "queue_claimable_idx" ON "queue" USING btree ("project_id","env","priority" DESC NULLS FIRST,"id") WHERE "queue"."locked_by" IS NULL;--> statement-breakpoint
CREATE INDEX "runs_task_created_idx" ON "runs" USING btree ("project_id","env","task_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_concurrency_idx" ON "runs" USING btree ("project_id","env","status","concurrency_key");--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("project_id","env","created_at");--> statement-breakpoint
CREATE INDEX "waits_status_resume_idx" ON "waits" USING btree ("project_id","env","status","resume_at");--> statement-breakpoint
CREATE INDEX "waits_child_run_idx" ON "waits" USING btree ("project_id","env","child_run_id");
