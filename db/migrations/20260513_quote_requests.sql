CREATE TABLE IF NOT EXISTS quote_requests (
  id              TEXT        PRIMARY KEY,
  form_session_id TEXT,
  name            TEXT,
  email           TEXT,
  phone           TEXT,
  country_code    TEXT,
  country_name    TEXT,
  company         TEXT,
  project_details TEXT,
  timeline        TEXT,
  budget          TEXT,
  opt_in          BOOLEAN     NOT NULL DEFAULT FALSE,
  source_url      TEXT,
  user_agent      TEXT,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quote_requests_email_idx ON quote_requests(email);
CREATE INDEX IF NOT EXISTS quote_requests_created_idx ON quote_requests(created_at DESC);

CREATE TABLE IF NOT EXISTS quote_request_files (
  id               TEXT        PRIMARY KEY,
  quote_request_id TEXT        NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  filename         TEXT        NOT NULL,
  mime_type        TEXT,
  size_bytes       INTEGER,
  blob_url         TEXT        NOT NULL,
  blob_pathname    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quote_request_files_qr_idx ON quote_request_files(quote_request_id);
