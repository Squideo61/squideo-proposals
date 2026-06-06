-- Notify when every client comment on a revision/storyboard draft has been
-- marked done. Broadcast notifications, so each user can toggle them; default
-- ON for Admin and the "Project Manager/Sales" role (id 'member'). Role-default
-- seeds do NOT self-heal — apply this migration to Neon.
UPDATE roles
   SET notification_defaults = notification_defaults
         || '{"revision.draft_completed": true, "storyboard.draft_completed": true}'::jsonb,
       updated_at = NOW()
 WHERE id IN ('admin', 'member');
