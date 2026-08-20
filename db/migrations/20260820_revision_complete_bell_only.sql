-- "Revisions complete" is a bell notification, not an email.
--
-- revision.draft_completed / storyboard.draft_completed fire when the team has
-- marked every client comment on a draft as done. That's an internal milestone
-- nobody has to act on from their inbox, and at one email per draft per project
-- it's pure noise — the bell (and the desktop push it raises) is the right
-- surface. Same treatment po.received and course.signup already get.
--
-- Defaults only: anyone who does want the email can turn it back on in their own
-- notification preferences, and the guard leaves an explicit choice untouched.
-- Idempotent; also self-healed in api/_lib/notifications.js
-- (ensureRevisionCompleteNotificationDefault).
UPDATE roles SET notification_channel_defaults = jsonb_set(
  notification_channel_defaults, '{revision.draft_completed}', '"in_app"'::jsonb, true)
 WHERE NOT (notification_channel_defaults ? 'revision.draft_completed');

UPDATE roles SET notification_channel_defaults = jsonb_set(
  notification_channel_defaults, '{storyboard.draft_completed}', '"in_app"'::jsonb, true)
 WHERE NOT (notification_channel_defaults ? 'storyboard.draft_completed');
