-- Images used in campaign bodies.
--
-- The bytes live in the private blob store; the row is what the public
-- /api/campaign-image route checks before relaying them. A recipient's mail
-- client can't authenticate to fetch a private blob, and it can't be handed a
-- data: URI either (every client strips those), so the image has to be
-- reachable at a plain URL that we serve.
CREATE TABLE IF NOT EXISTS email_campaign_images (
  id            TEXT        PRIMARY KEY,
  -- SET NULL rather than CASCADE: deleting a draft must not break the images in
  -- a campaign that has already gone out with them.
  campaign_id   TEXT        REFERENCES email_campaigns(id) ON DELETE SET NULL,
  filename      TEXT,
  mime_type     TEXT        NOT NULL,
  size_bytes    INTEGER,
  blob_url      TEXT        NOT NULL,
  blob_pathname TEXT,
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
