-- Per-notification delivery channel: in-app bell only, email only, or both.
-- Role sets the default; a per-user override can change it.
--
-- The app self-heals this schema at runtime (ensureNotificationChannelColumns
-- in api/_lib/notifications.js), so applying this migration is idempotent and
-- safe whether or not the columns already exist.

-- Per-user override of the delivery channel (NULL = inherit the role default).
ALTER TABLE user_notification_overrides
  ADD COLUMN IF NOT EXISTS channel TEXT;

-- A channel-only override (keep enabled at the role default, just change how
-- it's delivered) needs enabled to be nullable.
ALTER TABLE user_notification_overrides
  ALTER COLUMN enabled DROP NOT NULL;

-- Per-role default delivery channel per notification key: { key: 'in_app'|'email'|'both' }.
-- Anything unset resolves to 'both' in code (the historical bell + email behaviour).
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS notification_channel_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;
