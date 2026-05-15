-- Roles + per-user notification overrides.
--
-- Today the codebase treats `users.role` as a free-text TEXT column with only
-- two values ('admin' or 'member'). This migration upgrades that into a real
-- roles table so admins can:
--   1. define custom roles with arbitrary permission sets,
--   2. set per-role notification defaults,
-- with per-user overrides layered on top.
--
-- Backward compatibility: rows in `users` keep their current role IDs ('admin'
-- or 'member'). The seed inserts both. The FK with ON DELETE RESTRICT prevents
-- deleting a role that's still assigned.

CREATE TABLE IF NOT EXISTS roles (
  id                    TEXT        PRIMARY KEY,
  name                  TEXT        NOT NULL,
  permissions           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  notification_defaults JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_system             BOOLEAN     NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the two system roles. Admin gets the '*' wildcard and every
-- notification on by default. Member gets nothing — they have to be granted
-- explicitly. Idempotent via ON CONFLICT.
INSERT INTO roles (id, name, permissions, notification_defaults, is_system) VALUES
  (
    'admin',
    'Admin',
    '["*"]'::jsonb,
    '{
      "proposal.signed":        true,
      "proposal.first_view":    true,
      "payment.received":       true,
      "payment.partner_credit": true,
      "invoice.paid_manual":    true,
      "invoice.paid_xero":      true,
      "task.reminder":          true,
      "quote_request.new":      true,
      "quote_request.partial":  true
    }'::jsonb,
    true
  ),
  (
    'member',
    'Member',
    '[]'::jsonb,
    '{
      "proposal.signed":        false,
      "proposal.first_view":    true,
      "payment.received":       false,
      "payment.partner_credit": false,
      "invoice.paid_manual":    false,
      "invoice.paid_xero":      false,
      "task.reminder":          true,
      "quote_request.new":      false,
      "quote_request.partial":  false
    }'::jsonb,
    true
  )
ON CONFLICT (id) DO NOTHING;

-- Coerce any unexpected role values to 'member' so the FK below holds.
UPDATE users
   SET role = 'member'
 WHERE role IS NULL OR role NOT IN (SELECT id FROM roles);

-- Add the FK only if it doesn't exist yet (idempotent re-runs).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_fkey
      FOREIGN KEY (role) REFERENCES roles(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_notification_overrides (
  user_email       TEXT        NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  notification_key TEXT        NOT NULL,
  enabled          BOOLEAN     NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_email, notification_key)
);

CREATE INDEX IF NOT EXISTS user_notif_overrides_email_idx
  ON user_notification_overrides (user_email);
