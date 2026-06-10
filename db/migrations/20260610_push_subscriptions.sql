-- Web Push subscriptions for desktop notifications (Tier 2 background push).
-- One row per browser/device; a user may have several. The push library also
-- creates this lazily (CREATE TABLE IF NOT EXISTS) so the feature works before
-- this migration is applied — this file is the durable record.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_email);
