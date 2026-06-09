-- Two-channel in-app notifications + "pending payment marked paid" alert.
--
-- The bell is split into two feeds, decided per notification key in code by
-- channelForKey() (api/_lib/notificationsCatalog.js):
--   - 'finance' : sales & money updates (the £ bell, left of the bell)
--   - 'general' : everything else / project updates (the standard bell)
-- The split is purely presentational — in_app_notifications already carries
-- notification_key, so no schema change is needed for the channels themselves.
--
-- This migration:
--   1. Lets Directors + Project Managers (role 'member') see the £ bell, gated
--      by the new finance.notifications permission (Admin has it via '*').
--   2. Seeds the new pp.marked_paid broadcast key ON for sales/finance roles so
--      ticking a pending payment paid actually reaches them (a key absent from
--      notification_defaults resolves to OFF).
-- Both are also self-healed at runtime by ensureSystemRoles() so a workspace
-- that never runs this file still gets the correct state.

UPDATE roles
   SET permissions = permissions || '["finance.notifications"]'::jsonb,
       updated_at = NOW()
 WHERE id IN ('director', 'member')
   AND NOT (permissions @> '["finance.notifications"]'::jsonb);

UPDATE roles
   SET notification_defaults = notification_defaults || '{"pp.marked_paid": true}'::jsonb,
       updated_at = NOW()
 WHERE id IN ('admin', 'director', 'member')
   AND NOT (notification_defaults ? 'pp.marked_paid');

UPDATE roles
   SET notification_defaults = notification_defaults || '{"pp.marked_paid": false}'::jsonb,
       updated_at = NOW()
 WHERE id NOT IN ('admin', 'director', 'member')
   AND NOT (notification_defaults ? 'pp.marked_paid');
