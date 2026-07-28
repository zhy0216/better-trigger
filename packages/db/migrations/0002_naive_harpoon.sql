ALTER TABLE "runs" ADD COLUMN "fencing_token" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" DROP COLUMN "fencing_token";