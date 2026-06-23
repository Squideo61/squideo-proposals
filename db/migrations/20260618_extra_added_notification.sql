-- Extra-charge alerts: production managers (and anyone with production.access)
-- can now log ad-hoc extra charges on a deal during production. When they do,
-- Admins + Directors get an in-app + desktop-push alert (no email) via the new
-- 'extra.added' notification key, and the charge shows in Pending Payments.
--
-- This migration only seeds the role-default for the key (absent → OFF). Default
-- it ON for Admin + Director only — they own billing oversight; the production
-- team that logs the charge doesn't need pinging. Self-healed at runtime by
-- ensureExtraAddedNotificationDefault() so a workspace that skips this still
-- works. No schema change (deal_extras already feed the Pending Payments report).
UPDATE roles
   SET notification_defaults = notification_defaults || '{"extra.added": true}'::jsonb,
       updated_at = NOW()
 WHERE id IN ('admin', 'director')
   AND NOT (notification_defaults ? 'extra.added');
