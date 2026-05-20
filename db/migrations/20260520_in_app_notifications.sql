-- In-app notification feed (the bell / notification center).
--
-- One row per (recipient, event). Records are written by sendNotification in
-- api/_lib/notifications.js for the SAME resolved recipients that get the email
-- — so the in-app feed mirrors a user's email notifications, gated by the same
-- per-user/role preferences. read_at NULL = unread.
CREATE TABLE IF NOT EXISTS in_app_notifications (
  id               BIGSERIAL   PRIMARY KEY,
  user_email       TEXT        NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  notification_key TEXT        NOT NULL,
  title            TEXT        NOT NULL,
  body             TEXT,
  link             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at          TIMESTAMPTZ
);

-- Feed query: newest-first per user.
CREATE INDEX IF NOT EXISTS in_app_notif_user_created_idx
  ON in_app_notifications (user_email, created_at DESC);

-- Unread-badge count: partial index over just the unread rows.
CREATE INDEX IF NOT EXISTS in_app_notif_unread_idx
  ON in_app_notifications (user_email) WHERE read_at IS NULL;
