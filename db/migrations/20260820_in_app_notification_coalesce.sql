-- Roll repeated in-app notifications of the same kind into one row.
--
-- A client uploading eight brand files produced eight near-identical "Client
-- file: X" notifications. With these columns, the first upload lands normally
-- and each later one in the same group (while still unread, inside the window)
-- bumps coalesce_count and rewrites the row to a summary — "Client files: 8
-- uploaded" — instead of adding another.
--
-- coalesce_group is the batch identity (e.g. portal-upload:<dealId>:file).
-- NULL = this notification never coalesces, which is the default for everything.
-- Idempotent; also self-healed in api/_lib/notifications.js
-- (ensureInAppCoalesceColumns).
ALTER TABLE in_app_notifications ADD COLUMN IF NOT EXISTS coalesce_group TEXT;
ALTER TABLE in_app_notifications ADD COLUMN IF NOT EXISTS coalesce_count INTEGER NOT NULL DEFAULT 1;

-- Lookup for "the newest unread row of this group for this user".
CREATE INDEX IF NOT EXISTS in_app_notif_coalesce_idx
  ON in_app_notifications (user_email, coalesce_group, created_at DESC)
  WHERE read_at IS NULL AND coalesce_group IS NOT NULL;
