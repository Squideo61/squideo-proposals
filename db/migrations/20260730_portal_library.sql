-- Portal video library: past work uploaded by staff.
--
-- The library already surfaces two live sources (delivered review cuts and the
-- Drive "Signed Off" folder). This table is the third: videos we made for the
-- client BEFORE any of that existed — dropped in from manage mode so the client
-- has one place with everything we've ever delivered them.
--
-- Files live in the public revision blob store (the same one draft cuts use, so
-- they stream and play straight from a <video> tag); bytes are only ever handed
-- out through /api/portal/download?scope=archive, which checks org membership.

CREATE TABLE IF NOT EXISTS portal_library_items (
  id            TEXT        PRIMARY KEY,
  company_id    TEXT        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  deal_id       TEXT        REFERENCES deals(id) ON DELETE SET NULL,
  title         TEXT        NOT NULL,
  filename      TEXT,
  mime_type     TEXT,
  size_bytes    BIGINT,
  blob_url      TEXT        NOT NULL,
  blob_pathname TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS portal_library_items_company_idx
  ON portal_library_items(company_id, created_at DESC);
