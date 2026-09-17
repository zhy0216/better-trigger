-- Regenerated baseline: the whole better-trigger database shape in one initial
-- migration, replacing the old 0000-0016 chain (history stays in Git). Every
-- table, FK, index, CHECK and sequence belongs to the fixed "better_trigger"
-- schema, so a host project's public tables and its own
-- drizzle.__drizzle_migrations journal are never touched. The runtime migrator
-- (packages/db/src/migrate.ts) creates the journal schema/table before this
-- file runs, hence IF NOT EXISTS here; business tables are deliberately NOT
-- IF NOT EXISTS so an incompatible same-name object fails loudly.
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "better_trigger";--> statement-breakpoint
CREATE TABLE "better_trigger"."logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"run_id" text NOT NULL,
	"step_seq" integer,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logs_level_check" CHECK ("better_trigger"."logs"."level" IN ('debug','info','warn','error'))
);
--> statement-breakpoint
CREATE TABLE "better_trigger"."queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"run_id" text NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"concurrency_key" text,
	CONSTRAINT "queue_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "better_trigger"."run_retry_operations" (
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"source_run_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"retry_run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_retry_operations_project_id_env_source_run_id_operation_key_pk" PRIMARY KEY("project_id","env","source_run_id","operation_key")
);
--> statement-breakpoint
CREATE TABLE "better_trigger"."run_steps" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"fingerprint" text,
	"status" text NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_steps_run_id_seq_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_steps_kind_check" CHECK ("better_trigger"."run_steps"."kind" IN ('step','wait','trigger-and-wait','batch-trigger','now','random','uuid')),
	CONSTRAINT "run_steps_status_check" CHECK ("better_trigger"."run_steps"."status" IN ('completed','failed')),
	CONSTRAINT "run_steps_attempt_check" CHECK ("better_trigger"."run_steps"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "better_trigger"."runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"task_id" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb,
	"output" jsonb,
	"error" jsonb,
	"trigger_type" text NOT NULL,
	"parent_run_id" text,
	"code_version" text,
	"idempotency_key" text,
	"concurrency_key" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"max_recoveries" integer DEFAULT 10 NOT NULL,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_status_check" CHECK ("better_trigger"."runs"."status" IN ('queued','running','waiting','completed','failed','canceled')),
	CONSTRAINT "runs_trigger_type_check" CHECK ("better_trigger"."runs"."trigger_type" IN ('api','schedule','subtask','retry','dashboard')),
	CONSTRAINT "runs_attempt_check" CHECK ("better_trigger"."runs"."attempt" >= 1),
	CONSTRAINT "runs_recoveries_check" CHECK ("better_trigger"."runs"."recoveries" >= 0 AND "better_trigger"."runs"."recoveries" <= "better_trigger"."runs"."max_recoveries")
);
--> statement-breakpoint
CREATE TABLE "better_trigger"."schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"task_id" text NOT NULL,
	"cron_pattern" text NOT NULL,
	"cron_tz" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "better_trigger"."tasks" (
	"id" text NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"name" text NOT NULL,
	"file_path" text,
	"trigger_source" text DEFAULT 'api' NOT NULL,
	"cron_pattern" text,
	"cron_tz" text,
	"retry" jsonb,
	"concurrency_limit" integer,
	"latest_code_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_project_id_env_id_pk" PRIMARY KEY("project_id","env","id"),
	CONSTRAINT "tasks_trigger_source_check" CHECK ("better_trigger"."tasks"."trigger_source" IN ('api','schedule'))
);
--> statement-breakpoint
CREATE TABLE "better_trigger"."waits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"run_id" text NOT NULL,
	"step_seq" integer NOT NULL,
	"kind" text NOT NULL,
	"resume_at" timestamp with time zone,
	"child_run_id" text,
	"fingerprint" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waits_kind_check" CHECK ("better_trigger"."waits"."kind" IN ('duration','until','run')),
	CONSTRAINT "waits_status_check" CHECK ("better_trigger"."waits"."status" IN ('pending','completed','canceled'))
);
--> statement-breakpoint
CREATE TABLE "better_trigger"."workers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"name" text,
	"code_version" text NOT NULL,
	"runtime" text NOT NULL,
	"tasks" jsonb NOT NULL,
	"namespaces" jsonb DEFAULT '[{"projectId":"default","env":"prod"}]'::jsonb NOT NULL,
	"concurrency" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	CONSTRAINT "workers_status_check" CHECK ("better_trigger"."workers"."status" IN ('online','offline'))
);
--> statement-breakpoint
ALTER TABLE "better_trigger"."logs" ADD CONSTRAINT "logs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "better_trigger"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_trigger"."queue" ADD CONSTRAINT "queue_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "better_trigger"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_trigger"."run_retry_operations" ADD CONSTRAINT "run_retry_operations_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "better_trigger"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_trigger"."run_retry_operations" ADD CONSTRAINT "run_retry_operations_retry_run_id_runs_id_fk" FOREIGN KEY ("retry_run_id") REFERENCES "better_trigger"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_trigger"."run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "better_trigger"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_trigger"."runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "better_trigger"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_trigger"."schedules" ADD CONSTRAINT "schedules_project_id_env_task_id_tasks_project_id_env_id_fk" FOREIGN KEY ("project_id","env","task_id") REFERENCES "better_trigger"."tasks"("project_id","env","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_trigger"."waits" ADD CONSTRAINT "waits_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "better_trigger"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "better_trigger"."waits" ADD CONSTRAINT "waits_child_run_id_runs_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "better_trigger"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "logs_run_id_idx" ON "better_trigger"."logs" USING btree ("run_id","project_id","env","id");--> statement-breakpoint
CREATE INDEX "queue_concurrency_idx" ON "better_trigger"."queue" USING btree ("project_id","env","concurrency_key");--> statement-breakpoint
CREATE INDEX "queue_lease_until_idx" ON "better_trigger"."queue" USING btree ("project_id","env","lease_until") WHERE "better_trigger"."queue"."lease_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "queue_claimable_idx" ON "better_trigger"."queue" USING btree ("project_id","env","priority" DESC NULLS FIRST,"id") WHERE "better_trigger"."queue"."locked_by" IS NULL;--> statement-breakpoint
CREATE INDEX "run_retry_operations_source_run_id_fk_idx" ON "better_trigger"."run_retry_operations" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "run_retry_operations_retry_run_id_fk_idx" ON "better_trigger"."run_retry_operations" USING btree ("retry_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_task_idempotency_uniq" ON "better_trigger"."runs" USING btree ("project_id","env","task_id","idempotency_key") WHERE "better_trigger"."runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_task_created_idx" ON "better_trigger"."runs" USING btree ("project_id","env","task_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_concurrency_idx" ON "better_trigger"."runs" USING btree ("project_id","env","status","concurrency_key");--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "better_trigger"."runs" USING btree ("project_id","env","created_at");--> statement-breakpoint
CREATE INDEX "runs_parent_run_id_fk_idx" ON "better_trigger"."runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_task_id_unique" ON "better_trigger"."schedules" USING btree ("project_id","env","task_id");--> statement-breakpoint
CREATE INDEX "schedules_next_run_idx" ON "better_trigger"."schedules" USING btree ("project_id","env","next_run_at");--> statement-breakpoint
CREATE INDEX "waits_status_resume_idx" ON "better_trigger"."waits" USING btree ("project_id","env","status","resume_at");--> statement-breakpoint
CREATE INDEX "waits_child_run_idx" ON "better_trigger"."waits" USING btree ("project_id","env","child_run_id");--> statement-breakpoint
CREATE INDEX "waits_run_id_fk_idx" ON "better_trigger"."waits" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "waits_child_run_id_fk_idx" ON "better_trigger"."waits" USING btree ("child_run_id");--> statement-breakpoint
CREATE INDEX "waits_run_idx" ON "better_trigger"."waits" USING btree ("project_id","env","run_id","step_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "waits_pending_step_uniq" ON "better_trigger"."waits" USING btree ("project_id","env","run_id","step_seq","kind") WHERE "better_trigger"."waits"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "workers_online_heartbeat_idx" ON "better_trigger"."workers" USING btree ("last_heartbeat_at") WHERE "better_trigger"."workers"."status" = 'online';