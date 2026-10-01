-- Rollback for 003_bot_verification.sql.  Drops only the verification evidence.
-- Run by hand only (psql "$DATABASE_URL" -f server/migrations/003_bot_verification.down.sql).
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS last_verified_at;
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS last_roundtrip_ms;
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS last_failure_at;
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS pending_verify_at;
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS recent_outcomes;
UPDATE grokbot_requests SET status = 'in_progress' WHERE status = 'waiting';
ALTER TABLE grokbot_requests DROP CONSTRAINT IF EXISTS grokbot_requests_status_check;
ALTER TABLE grokbot_requests ADD CONSTRAINT grokbot_requests_status_check CHECK (status IN ('requested', 'delivered', 'in_progress', 'completed', 'failed'));
DELETE FROM royal_migrations WHERE name = '003_bot_verification.sql';
