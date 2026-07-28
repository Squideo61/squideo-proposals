-- Append-only log of customer-portal activity that has no home on a domain
-- table -- chiefly LOGINS (portal_users.last_login_at only keeps the latest, so
-- there was no login history, IP or location). Client ACTION events (file
-- uploads, voiceover picks, deposits, PO submissions, extras, quotes...) are read
-- from their own authoritative timestamp columns and are deliberately NOT copied
-- here, so the log can never drift from the real records.
--
-- Mirrored at runtime by ensurePortalTables() in api/_lib/portal/db.js.

CREATE TABLE IF NOT EXISTS portal_activity (
  id             TEXT        PRIMARY KEY,
  portal_user_id TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  company_id     TEXT        REFERENCES companies(id) ON DELETE SET NULL,
  deal_id        TEXT,
  event_key      TEXT        NOT NULL,   -- 'login' (extensible)
  detail         JSONB,
  ip             TEXT,
  country        TEXT,
  region         TEXT,
  city           TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS portal_activity_user_idx ON portal_activity(portal_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_activity_company_idx ON portal_activity(company_id, created_at DESC);
