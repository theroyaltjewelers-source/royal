-- Verified Grok Bot connectivity: the evidence behind CONNECTED_VERIFIED.
-- Additive only; existing rows keep their values and read as unverified.
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS last_verified_at  timestamptz;
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS last_roundtrip_ms integer;
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS last_failure_at   timestamptz;
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS pending_verify_at timestamptz;
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS recent_outcomes   text NOT NULL DEFAULT '' CHECK (recent_outcomes ~ '^[01]{0,20}$');
