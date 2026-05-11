CREATE TABLE IF NOT EXISTS deal_files (
  id            TEXT        PRIMARY KEY,
  deal_id       TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  filename      TEXT        NOT NULL,
  mime_type     TEXT,
  size_bytes    INTEGER,
  blob_url      TEXT        NOT NULL,
  blob_pathname TEXT,
  uploaded_by   TEXT        REFERENCES users(email) ON DELETE SET NULL,
  source        TEXT        NOT NULL DEFAULT 'upload',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deal_files_deal_id_idx ON deal_files(deal_id);

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS gmail_attachments JSONB;
