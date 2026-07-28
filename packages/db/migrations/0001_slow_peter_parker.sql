ALTER TABLE "queue" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "fencing_token" bigint DEFAULT 0 NOT NULL;