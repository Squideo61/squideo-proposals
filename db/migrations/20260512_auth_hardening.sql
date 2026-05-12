-- Login rate-limit tracking. One row per (email, IP) pair; cleared on
-- successful login. Used to throttle credential-stuffing.
CREATE TABLE IF NOT EXISTS failed_logins (
  email      TEXT NOT NULL,
  ip         TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 1,
  first_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, ip)
);
CREATE INDEX IF NOT EXISTS idx_failed_logins_last_at ON failed_logins(last_at);
