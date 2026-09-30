-- ROYAL's own store: decisions, tasks, commitments, snapshots, notifications
-- and every other record kind, plus the append-only audit and events logs.
-- core/pgstore.js implements the Store contract in core/store.js on these.

CREATE TABLE IF NOT EXISTS royal_records (
  kind       text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$' AND kind NOT IN ('audit', 'events')),
  id         text NOT NULL CHECK (length(id) BETWEEN 1 AND 512),
  data       jsonb NOT NULL,
  rev        integer NOT NULL CHECK (rev >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS royal_log (
  log        text NOT NULL CHECK (log IN ('audit', 'events')),
  seq        bigserial,
  id         text NOT NULL,
  key        text,
  record     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (log, seq)
);
CREATE INDEX IF NOT EXISTS royal_log_key ON royal_log (log, key) WHERE key IS NOT NULL;

-- Append-only in the database as well as in code: no UPDATE, DELETE or
-- TRUNCATE of the log, whoever the caller is.
CREATE OR REPLACE FUNCTION royal_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'STORE_APPEND_ONLY: royal_log can only be appended to';
END;
$$;
DROP TRIGGER IF EXISTS royal_log_no_change ON royal_log;
CREATE TRIGGER royal_log_no_change BEFORE UPDATE OR DELETE ON royal_log
  FOR EACH ROW EXECUTE FUNCTION royal_log_append_only();
DROP TRIGGER IF EXISTS royal_log_no_truncate ON royal_log;
CREATE TRIGGER royal_log_no_truncate BEFORE TRUNCATE ON royal_log
  FOR EACH STATEMENT EXECUTE FUNCTION royal_log_append_only();
