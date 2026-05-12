CREATE TABLE IF NOT EXISTS deal_comments (
  id         TEXT PRIMARY KEY,
  deal_id    TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES deal_comments(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  mentions   TEXT[] DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users(email),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deal_comments_deal ON deal_comments(deal_id, created_at ASC);
