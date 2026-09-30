-- Rollback for 001_grokbot.sql.  Destroys every bot request, event and token.
-- Run by hand only (psql "$DATABASE_URL" -f server/migrations/001_grokbot.down.sql).
DROP TABLE IF EXISTS grokbot_events;
DROP TABLE IF EXISTS grokbot_requests;
DROP TABLE IF EXISTS grokbot_bot_tokens;
DROP TABLE IF EXISTS grokbot_bot_state;
DELETE FROM royal_migrations WHERE name = '001_grokbot.sql';
