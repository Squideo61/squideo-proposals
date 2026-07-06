-- Schedule clashes → Project/Production Managers only.
--
-- The 'schedule.conflict' broadcast notification was previously defaulted ON
-- for Admin, Director AND Project/Production Manager (role 'member'). Only the
-- production managers run the weekly schedule and rearrange it when a block
-- can't fit, so the clash alert now defaults ON for them alone.
--
-- Admins & Directors keep the ability to opt back in individually (a per-user
-- override in Account settings) or to re-enable the role default in the admin
-- Notifications tab — the '_schedule_conflict_pm_only' sentinel below stops the
-- runtime self-heal (ensureSystemRoles) from re-flipping it after that.
--
-- These same changes are self-healed at runtime by ensureSystemRoles() so a
-- workspace that skips this apply still ends up correct.

-- Make sure Project/Production Managers keep (or gain) the default.
UPDATE roles
   SET notification_defaults = notification_defaults || '{"schedule.conflict": true}'::jsonb,
       updated_at = NOW()
 WHERE id = 'member'
   AND NOT (notification_defaults ? 'schedule.conflict');

-- Turn the default OFF for Admins & Directors, once (sentinel-guarded).
UPDATE roles
   SET notification_defaults = notification_defaults
                             || '{"schedule.conflict": false, "_schedule_conflict_pm_only": true}'::jsonb,
       updated_at = NOW()
 WHERE id IN ('admin', 'director')
   AND NOT (notification_defaults ? '_schedule_conflict_pm_only');
