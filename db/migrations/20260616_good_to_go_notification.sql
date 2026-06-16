-- "Good to go" gate: a deal no longer auto-enters production when it's paid.
-- Instead a person marks it "Good to go" (once it's signed / paid / on a PO),
-- which moves it onto the production board AND alerts the project managers.
--
-- This migration only seeds the notification role-default for the new
-- 'project.good_to_go' broadcast key (a key absent from notification_defaults
-- resolves to OFF). Default it ON for Admin / Director / Project Manager
-- (role id 'member') — the roles that run production. The same defaults are
-- self-healed at runtime by ensureSystemRoles() so a workspace that skips this
-- apply still works; no schema/column change is needed (the move itself reuses
-- deals.production_phase / production_entered_at via enterProduction()).
UPDATE roles
   SET notification_defaults = notification_defaults || '{"project.good_to_go": true}'::jsonb,
       updated_at = NOW()
 WHERE id IN ('admin', 'director', 'member')
   AND NOT (notification_defaults ? 'project.good_to_go');
