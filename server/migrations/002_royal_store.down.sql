-- Rollback for 002_royal_store.sql.  Destroys every Decision, task, snapshot
-- and notification, and the whole audit and events log.
-- Run by hand only (psql "$DATABASE_URL" -f server/migrations/002_royal_store.down.sql).
DROP TABLE IF EXISTS royal_log;
DROP TABLE IF EXISTS royal_records;
DROP FUNCTION IF EXISTS royal_log_append_only();
DELETE FROM royal_migrations WHERE name = '002_royal_store.sql';
