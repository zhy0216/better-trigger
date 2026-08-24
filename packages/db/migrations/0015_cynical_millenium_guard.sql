CREATE TABLE "run_retry_operations" (
	"project_id" text DEFAULT 'default' NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"source_run_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"retry_run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_retry_operations_project_id_env_source_run_id_operation_key_pk" PRIMARY KEY("project_id","env","source_run_id","operation_key")
);
--> statement-breakpoint
ALTER TABLE "run_retry_operations" ADD CONSTRAINT "run_retry_operations_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_retry_operations" ADD CONSTRAINT "run_retry_operations_retry_run_id_runs_id_fk" FOREIGN KEY ("retry_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;