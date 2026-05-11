-- Two-factor authentication (TOTP authenticator + email code + backup codes).
-- Mandatory for every user: anyone without totp_enrolled = TRUE is forced
-- through the enrolment flow on their next login.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret        TEXT,
  ADD COLUMN IF NOT EXISTS totp_enrolled      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS backup_code_hashes TEXT[]  NOT NULL DEFAULT '{}';

-- Short-lived one-time codes sent by email. One active row per (email, purpose).
CREATE TABLE IF NOT EXISTS email_otps (
  email      TEXT        NOT NULL,
  purpose    TEXT        NOT NULL,            -- 'login' | 'enrol'
  code_hash  TEXT        NOT NULL,            -- sha256 hex of the 6-digit code
  attempts   INT         NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, purpose)
);

-- "Remember this browser for 30 days" cookies. Cookie value is random;
-- only its sha256 hash is stored here.
CREATE TABLE IF NOT EXISTS trusted_devices (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  token_hash    TEXT        NOT NULL UNIQUE,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS trusted_devices_email_idx ON trusted_devices(email);
