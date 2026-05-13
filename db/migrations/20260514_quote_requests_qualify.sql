ALTER TABLE quote_requests
  ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS contact_id    TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deal_id       TEXT REFERENCES deals(id)    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at   TIMESTAMPTZ;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS provisional   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source        TEXT;

CREATE INDEX IF NOT EXISTS quote_requests_status_idx
  ON quote_requests(status, created_at DESC);
