-- Verified Grok Bot connectivity: the evidence behind CONNECTED_VERIFIED.
-- Additive: new evidence columns, and one wider request status check. Existing rows read as unverified.
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS last_verified_at  timestamptz;
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS last_roundtrip_ms integer;
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS last_failure_at   timestamptz;
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS pending_verify_at timestamptz;
ALTER TABLE grokbot_bot_state ADD COLUMN IF NOT EXISTS recent_outcomes   text NOT NULL DEFAULT '' CHECK (recent_outcomes ~ '^[01]{0,20}$');

-- A bot may say it is waiting on someone; the request records that.
ALTER TABLE grokbot_requests DROP CONSTRAINT IF EXISTS grokbot_requests_status_check;
ALTER TABLE grokbot_requests ADD CONSTRAINT grokbot_requests_status_check CHECK (status IN ('requested', 'delivered', 'in_progress', 'waiting', 'completed', 'failed'));
