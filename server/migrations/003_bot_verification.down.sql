-- Rollback for 003_bot_verification.sql.  Drops only the verification evidence.
-- Run by hand only (psql "$DATABASE_URL" -f server/migrations/003_bot_verification.down.sql).
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS last_verified_at;
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS last_roundtrip_ms;
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS last_failure_at;
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS pending_verify_at;
ALTER TABLE grokbot_bot_state DROP COLUMN IF EXISTS recent_outcomes;
DELETE FROM royal_migrations WHERE name = '003_bot_verification.sql';
