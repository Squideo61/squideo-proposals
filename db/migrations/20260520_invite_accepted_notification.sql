-- Seed role defaults for the new 'user.invite_accepted' notification.
--
-- The recipient resolver treats a key that's absent from a role's
-- notification_defaults as OFF, so without this admins would never receive the
-- "new teammate joined" alert. Mirror how the other broadcast alerts behave:
-- on by default for admins (the '*' wildcard role), off for everyone else.
-- Per-user overrides in user_notification_overrides still take precedence, so
-- anyone can opt in/out from their notification preferences afterwards.

-- Admins: on by default.
UPDATE roles
   SET notification_defaults = jsonb_set(notification_defaults, '{user.invite_accepted}', 'true', true),
       updated_at = NOW()
 WHERE permissions @> '["*"]'::jsonb
   AND NOT (notification_defaults ? 'user.invite_accepted');

-- Every other role: off by default.
UPDATE roles
   SET notification_defaults = jsonb_set(notification_defaults, '{user.invite_accepted}', 'false', true),
       updated_at = NOW()
 WHERE NOT (permissions @> '["*"]'::jsonb)
   AND NOT (notification_defaults ? 'user.invite_accepted');
