-- "Copywriter" account type — for now identical to Producer (script/production
-- work), just a distinct role name. Gets revisions.access + production.access
-- so it can work the production board (upload/approve scripts, etc.). The app
-- shell locks it to the same stripped producer view.
--
-- Idempotent. Also self-healed at runtime by ensureSystemRoles() in
-- api/_lib/userRoles.js, so a manual Neon apply is optional.
INSERT INTO roles (id, name, permissions, notification_defaults, is_system) VALUES
  (
    'copywriter',
    'Copywriter',
    '["revisions.access", "production.access"]'::jsonb,
    '{}'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;
