CREATE TABLE IF NOT EXISTS quote_request_partials (
  form_session_id  TEXT        PRIMARY KEY,
  name             TEXT,
  email            TEXT,
  phone            TEXT,
  country_code     TEXT,
  country_name     TEXT,
  company          TEXT,
  project_details  TEXT,
  timeline         TEXT,
  budget           TEXT,
  source_url       TEXT,
  user_agent       TEXT,
  ip_address       TEXT,
  last_step        SMALLINT,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at      TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quote_request_partials_pending_idx
  ON quote_request_partials (last_activity_at)
  WHERE notified_at IS NULL AND completed_at IS NULL;
