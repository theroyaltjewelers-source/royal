-- Grok Bot bridge: requests, events, per-bot tokens, per-bot state.
-- Every table carries bot_id; every query in core/grokbot/store.js filters on it.

CREATE TABLE IF NOT EXISTS grokbot_requests (
  id              uuid PRIMARY KEY,
  bot_id          text NOT NULL CHECK (bot_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  realm           text NOT NULL CHECK (realm IN ('BUSINESS', 'PERSONAL')),
  conversation_id text,
  skill           text,
  content         text NOT NULL DEFAULT '' CHECK (length(content) <= 100000),
  status          text NOT NULL CHECK (status IN ('requested', 'delivered', 'in_progress', 'completed', 'failed')),
  requested_by    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  CONSTRAINT grokbot_requests_id_bot UNIQUE (id, bot_id, realm)
);
CREATE INDEX IF NOT EXISTS grokbot_requests_bot ON grokbot_requests (bot_id, created_at);

CREATE TABLE IF NOT EXISTS grokbot_events (
  id               bigserial PRIMARY KEY,
  bot_id           text NOT NULL CHECK (bot_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  realm            text NOT NULL CHECK (realm IN ('BUSINESS', 'PERSONAL')),
  request_id       uuid,
  type             text NOT NULL CHECK (type IN ('progress', 'result', 'alert', 'message', 'outbound')),
  content_markdown text NOT NULL CHECK (length(content_markdown) <= 100000),
  status           text CHECK (status IS NULL OR status ~ '^[a-z_]{1,32}$'),
  author           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- An event can only point at a request that belongs to the same bot, in the same realm.
  CONSTRAINT grokbot_events_request_same_bot FOREIGN KEY (request_id, bot_id, realm) REFERENCES grokbot_requests (id, bot_id, realm)
);
CREATE INDEX IF NOT EXISTS grokbot_events_bot_id ON grokbot_events (bot_id, id);
CREATE INDEX IF NOT EXISTS grokbot_events_realm_id ON grokbot_events (realm, id);

CREATE TABLE IF NOT EXISTS grokbot_bot_tokens (
  id           uuid PRIMARY KEY,
  bot_id       text NOT NULL CHECK (bot_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  prefix       text NOT NULL UNIQUE,
  token_hash   text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
-- One active token per bot.
CREATE UNIQUE INDEX IF NOT EXISTS grokbot_bot_tokens_one_active ON grokbot_bot_tokens (bot_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS grokbot_bot_state (
  bot_id          text PRIMARY KEY CHECK (bot_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  last_seen       timestamptz,
  last_message_at timestamptz,
  last_error      text
);
