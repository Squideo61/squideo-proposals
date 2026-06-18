-- @-mention notifications: tagging a teammate in a comment on a deal or project
-- now pings them (Updates bell + email + desktop push) via the new
-- 'comment.mention' notification key.
--
-- This migration only seeds the role-default for the key (a key absent from
-- notification_defaults resolves to OFF). Default it ON for EVERY role — a
-- mention is a direct, deliberate ping, so anyone can be tagged and should hear
-- about it unless they explicitly mute it in Account → Notifications. The same
-- default is self-healed at runtime by ensureCommentMentionNotificationDefault()
-- so a workspace that skips this apply still works; no schema change is needed.
UPDATE roles
   SET notification_defaults = notification_defaults || '{"comment.mention": true}'::jsonb,
       updated_at = NOW()
 WHERE NOT (notification_defaults ? 'comment.mention');
