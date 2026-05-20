-- "Producer" account type: a system role limited to the video Revisions
-- section. Producers get only the revisions.access permission; the app shell
-- locks them to that section on sign-in.
INSERT INTO roles (id, name, permissions, notification_defaults, is_system) VALUES
  (
    'producer',
    'Producer',
    '["revisions.access"]'::jsonb,
    '{}'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;

-- Revisions are visible to every existing role by default. Admins already have
-- the '*' wildcard; grant revisions.access to all other roles (Member + any
-- custom roles) that don't already have it. Idempotent.
UPDATE roles
   SET permissions = permissions || '["revisions.access"]'::jsonb,
       updated_at  = NOW()
 WHERE NOT (permissions @> '["*"]'::jsonb)
   AND NOT (permissions @> '["revisions.access"]'::jsonb);
