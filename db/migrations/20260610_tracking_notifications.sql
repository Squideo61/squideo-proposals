-- Engagement "tracking" notification bell (the eye, left of the £ bell): alerts
-- the owner when an email they sent is opened, or a proposal they own is opened.
--
-- open_notified_at gates the email-open alert to fire once per email (first real
-- open). Both the track endpoint and the views endpoint also self-heal these
-- (column + role defaults), so the feature works before this migration runs —
-- this file is the durable record.

ALTER TABLE email_tracking ADD COLUMN IF NOT EXISTS open_notified_at TIMESTAMPTZ;

-- Seed the two new notification prefs per role by copying each role's existing
-- proposal.first_view setting (sales-facing roles get them on). Only fills roles
-- that don't already have the keys.
UPDATE roles SET notification_defaults = jsonb_set(
  notification_defaults, '{tracking.email_opened}',
  COALESCE(notification_defaults->'proposal.first_view', 'false'::jsonb), true)
 WHERE NOT (notification_defaults ? 'tracking.email_opened');

UPDATE roles SET notification_defaults = jsonb_set(
  notification_defaults, '{tracking.proposal_opened}',
  COALESCE(notification_defaults->'proposal.first_view', 'false'::jsonb), true)
 WHERE NOT (notification_defaults ? 'tracking.proposal_opened');
