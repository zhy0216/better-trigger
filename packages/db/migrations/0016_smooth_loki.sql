-- FK-support indexes, the workers online scan, and the two CHECKs 0011 missed
-- (plan repo-improvements, todo 03: P1 prune cascades, P2 hardening
-- consistency).
--
-- (1) `*_fk_idx` below, and the run_id-leading rebuild of logs_run_id_idx:
-- Postgres enforces a foreign key by looking up the REFERENCING column alone —
-- deleting a run checks `DELETE FROM logs WHERE run_id = $1`,
-- `DELETE FROM waits WHERE run_id = $1`,
-- `UPDATE waits SET child_run_id = NULL WHERE child_run_id = $1`,
-- `UPDATE runs SET parent_run_id = NULL WHERE parent_run_id = $1` and both
-- run_retry_operations cascades. None of those statements mentions the
-- namespace, so 0010's (project_id, env, ...) prefix left every one of them
-- reading the whole dependent table: measured on a seeded database (50k runs,
-- 300k logs, 120k waits, 50k operations), prune's
-- `DELETE FROM runs WHERE id = ANY(...)` paid a sequential scan on logs, waits
-- (run_id), runs (parent_run_id) and run_retry_operations (both columns — 0015
-- gave that table no secondary index at all), plus a full walk of
-- waits_child_run_idx for the child_run_id SET NULL.
-- These indexes must NOT gain a namespace prefix later: that is precisely what
-- defeats the lookup they exist for. The namespace-led indexes they sit next
-- to (waits_run_idx, waits_child_run_idx) stay — the application queries that
-- do filter by namespace bind those leading columns (C2, p1-06).
--
-- (2) workers_online_heartbeat_idx: the workers table is append-only history
-- with no secondary index at all, while the online-only scans (offline marker,
-- served-task probe, stranded scan, registration's ownership check) run every
-- second to every 30s and expand jsonb_array_elements(tasks) per row they
-- read. Partial on status = 'online' so the index size tracks the live set
-- instead of the history. No GIN(tasks): the probes only ever run over the
-- online subset (which this index makes cheap to reach) and match through a
-- COALESCE expression a GIN on the raw column cannot bind.
--
-- (3) runs_trigger_type_check / tasks_trigger_source_check: 0011 CHECKed every
-- other closed enum (status/kind/level) but not these two columns, although
-- backend-contract.md §2 lists both as closed sets.
--
-- Like 0011, the two CHECKs assume the pre-existing trigger_type /
-- trigger_source values are ALREADY inside their legal sets — everything this
-- engine has ever written is (upsertTask writes 'schedule' only for a cron
-- task; createRun writes 'api' / 'schedule' / 'subtask' / 'retry'), so a
-- database migrated by the engine needs no data fixes. A hand-written row
-- outside the set fails `ADD CONSTRAINT ... CHECK`, which stops every daemon
-- from booting (daemons auto-migrate at startup); fix the row first, e.g.
--   SELECT id, trigger_type FROM runs WHERE trigger_type NOT IN
--     ('api','schedule','subtask','retry','dashboard');
--   UPDATE tasks SET trigger_source = 'api' WHERE trigger_source NOT IN
--     ('api','schedule');   -- per row, after deciding what it meant.
-- There is deliberately no automatic cleanup: guessing would corrupt data.
--
-- Index creation is plain (not CONCURRENTLY): the migrator runs each file in
-- one transaction, where CONCURRENTLY is not allowed, so each CREATE takes a
-- SHARE lock on its table for the length of the rebuild. That is the same
-- trade every previous index migration in this repo made, and it is bounded by
-- the table sizes retention is expected to keep; operators with a multi-million
-- row logs table should prune (or at least VACUUM ANALYZE) before upgrading.
--> statement-breakpoint
DROP INDEX "logs_run_id_idx";--> statement-breakpoint
CREATE INDEX "run_retry_operations_source_run_id_fk_idx" ON "run_retry_operations" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "run_retry_operations_retry_run_id_fk_idx" ON "run_retry_operations" USING btree ("retry_run_id");--> statement-breakpoint
CREATE INDEX "runs_parent_run_id_fk_idx" ON "runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "waits_run_id_fk_idx" ON "waits" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "waits_child_run_id_fk_idx" ON "waits" USING btree ("child_run_id");--> statement-breakpoint
CREATE INDEX "workers_online_heartbeat_idx" ON "workers" USING btree ("last_heartbeat_at") WHERE "workers"."status" = 'online';--> statement-breakpoint
CREATE INDEX "logs_run_id_idx" ON "logs" USING btree ("run_id","project_id","env","id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_type_check" CHECK ("runs"."trigger_type" IN ('api','schedule','subtask','retry','dashboard'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_trigger_source_check" CHECK ("tasks"."trigger_source" IN ('api','schedule'));