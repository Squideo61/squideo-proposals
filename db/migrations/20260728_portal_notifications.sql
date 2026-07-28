-- Client-facing notification feed for the customer portal. The staff
-- notification system (in_app_notifications) is FK'd to users(email) and can
-- only target internal staff — clients live in portal_users, so they need their
-- own feed. Keyed to portal_users(id) (TEXT, pu_ prefix). Self-healed at runtime
-- by ensurePortalTables() in api/_lib/portal/db.js — this file is for
-- record-keeping / manual application.

CREATE TABLE IF NOT EXISTS portal_notifications (
  id               TEXT        PRIMARY KEY,               -- ntf_ prefix (makeId)
  portal_user_id   TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  company_id       TEXT        REFERENCES companies(id) ON DELETE CASCADE,
  deal_id          TEXT,
  notification_key TEXT,
  title            TEXT        NOT NULL,
  body             TEXT,
  link             TEXT,                                  -- portal hash route, e.g. '#/project/<id>'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at          TIMESTAMPTZ
);

-- Feed query: newest-first per portal user.
CREATE INDEX IF NOT EXISTS portal_notifications_user_idx
  ON portal_notifications(portal_user_id, created_at DESC);

-- Unread-badge count: partial index over just the unread rows.
CREATE INDEX IF NOT EXISTS portal_notifications_unread_idx
  ON portal_notifications(portal_user_id) WHERE read_at IS NULL;
