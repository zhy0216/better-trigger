CREATE TABLE "logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"run_id" text NOT NULL,
	"step_seq" integer,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"run_id" text NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"concurrency_key" text,
	CONSTRAINT "queue_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"status" text NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_steps_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
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
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"run_id" text NOT NULL,
	"step_seq" integer NOT NULL,
	"kind" text NOT NULL,
	"resume_at" timestamp with time zone,
	"child_run_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"name" text,
	"code_version" text NOT NULL,
	"runtime" text NOT NULL,
	"tasks" jsonb NOT NULL,
	"concurrency" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'online' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "logs_run_id_idx" ON "logs" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "queue_available_priority_idx" ON "queue" USING btree ("available_at","priority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "queue_concurrency_idx" ON "queue" USING btree ("concurrency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_task_idempotency_uniq" ON "runs" USING btree ("task_id","idempotency_key") WHERE "runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_task_created_idx" ON "runs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_concurrency_idx" ON "runs" USING btree ("status","concurrency_key");--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "waits_status_resume_idx" ON "waits" USING btree ("status","resume_at");--> statement-breakpoint
CREATE INDEX "waits_child_run_idx" ON "waits" USING btree ("child_run_id");