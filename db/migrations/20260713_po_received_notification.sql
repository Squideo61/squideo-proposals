-- "Purchase order received" notification (po.received).
--
-- Fires when a teammate records a client PO against a deal (uploads the document
-- or just types the number). A key absent from notification_defaults resolves to
-- OFF, so it has to be seeded explicitly for the roles that need it:
--   admin / director / member (Project & Production Managers) → ON
--   producer / copywriter / marketing / freelancer            → left OFF
--
-- Delivery defaults to in-app only (the £ bell + desktop push) rather than
-- 'both' — POs land often enough that an email each time would be noise. Anyone
-- can switch themselves to email/both in Account settings.
--
-- Mirrored by ensurePoReceivedNotificationDefault() in api/_lib/notifications.js,
-- so this is idempotent and safe to re-run.

UPDATE roles
   SET notification_defaults = jsonb_set(notification_defaults, '{po.received}', 'true'::jsonb, true),
       updated_at = NOW()
 WHERE id IN ('admin', 'director', 'member')
   AND NOT (notification_defaults ? 'po.received');

ALTER TABLE roles ADD COLUMN IF NOT EXISTS notification_channel_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE roles
   SET notification_channel_defaults = jsonb_set(notification_channel_defaults, '{po.received}', '"in_app"'::jsonb, true),
       updated_at = NOW()
 WHERE NOT (notification_channel_defaults ? 'po.received');
