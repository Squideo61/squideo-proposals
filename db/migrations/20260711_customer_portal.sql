-- Customer portal: org-based client accounts (an org = a companies row), with
-- password + magic-link auth, self-invites, org/brand files, and per-deal
-- discounted extras offers. Also self-healed at runtime by ensurePortalTables()
-- in api/_lib/portal/db.js, so a manual Neon apply is optional but recommended.

-- Portal identities. Deliberately separate from staff `users` (different auth
-- surface, different lifecycle, no roles/permissions/TOTP).
CREATE TABLE IF NOT EXISTS portal_users (
  id             TEXT        PRIMARY KEY,             -- pu_ prefix
  email          TEXT        NOT NULL UNIQUE,         -- stored lowercased
  name           TEXT,
  phone          TEXT,
  job_title      TEXT,
  password_hash  TEXT,                                -- bcryptjs cost 12
  contact_id     TEXT        REFERENCES contacts(id) ON DELETE SET NULL,
  token_version  INTEGER     NOT NULL DEFAULT 0,      -- session revocation
  disabled_at    TIMESTAMPTZ,                         -- staff kill-switch
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Org membership. A person can belong to more than one company (one row per
-- company); the portal shows an org switcher when count > 1.
CREATE TABLE IF NOT EXISTS portal_memberships (
  portal_user_id TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  company_id     TEXT        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invited_by     TEXT,                                -- 'system:signature' | portal_user id | staff email
  disabled_at    TIMESTAMPTZ,                         -- per-org revoke
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (portal_user_id, company_id)
);
CREATE INDEX IF NOT EXISTS portal_memberships_company_idx ON portal_memberships(company_id);

-- Invites (both the post-signing welcome and colleague self-invites). Only the
-- SHA-256 hash of the token is stored; the raw token lives in the email link.
CREATE TABLE IF NOT EXISTS portal_invites (
  id             TEXT        PRIMARY KEY,             -- pin_
  email          TEXT        NOT NULL,                -- lowercased
  company_id     TEXT        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_hash     TEXT        NOT NULL UNIQUE,
  prefill        JSONB,                               -- { name, phone, jobTitle }
  invited_by     TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,                -- 14 days
  accepted_at    TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS portal_invites_email_idx ON portal_invites(email);
CREATE INDEX IF NOT EXISTS portal_invites_company_idx ON portal_invites(company_id);

-- One-time login tokens: magic-link (15 min) and password reset (60 min).
-- Hash-only storage, single-use via used_at.
CREATE TABLE IF NOT EXISTS portal_login_tokens (
  id             TEXT        PRIMARY KEY,             -- plt_
  portal_user_id TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  token_hash     TEXT        NOT NULL UNIQUE,
  purpose        TEXT        NOT NULL,                -- 'magic_link' | 'password_reset'
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS portal_login_tokens_user_idx ON portal_login_tokens(portal_user_id, created_at DESC);

-- Login lockout mirror of staff failed_logins (5 fails / 10 min per email+IP).
CREATE TABLE IF NOT EXISTS portal_failed_logins (
  email        TEXT        NOT NULL,
  ip           TEXT        NOT NULL,
  attempts     INTEGER     NOT NULL DEFAULT 1,
  first_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, ip)
);

-- Org-level files (brand guidelines etc.), distinct from per-deal deal_files.
CREATE TABLE IF NOT EXISTS portal_company_files (
  id             TEXT        PRIMARY KEY,             -- pcf_
  company_id     TEXT        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category       TEXT        NOT NULL DEFAULT 'brand',-- 'brand' | 'document'
  filename       TEXT        NOT NULL,
  mime_type      TEXT,
  size_bytes     INTEGER,
  blob_url       TEXT        NOT NULL,                -- PRIVATE blob store
  blob_pathname  TEXT,
  uploaded_by_portal_user TEXT REFERENCES portal_users(id) ON DELETE SET NULL,
  uploaded_by_staff       TEXT REFERENCES users(email) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS portal_company_files_idx ON portal_company_files(company_id);

-- Per-deal portal extras: staff overrides of proposal-derived offers + fully
-- custom upsells. Proposal-derived offers are computed live server-side
-- (api/_lib/portal/extrasOffers.js); this table stores only the deltas.
CREATE TABLE IF NOT EXISTS portal_extra_offers (
  id                TEXT        PRIMARY KEY,          -- pxo_
  deal_id           TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind              TEXT        NOT NULL DEFAULT 'custom', -- 'custom' | 'override'
  proposal_extra_id TEXT,                             -- kind='override': id in proposals.data.optionalExtras
  title             TEXT,
  description       TEXT,
  amount            NUMERIC,                          -- ex-VAT; custom = final price, override = price override
  hidden            BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by        TEXT        REFERENCES users(email) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS portal_extra_offers_deal_idx ON portal_extra_offers(deal_id);

-- Per-deal discount applied to proposal-derived portal extras (fraction).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS portal_extras_discount NUMERIC NOT NULL DEFAULT 0.10;

-- Attribution columns on existing tables.
ALTER TABLE deal_extras    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff'; -- 'staff' | 'portal'
ALTER TABLE deal_extras    ADD COLUMN IF NOT EXISTS portal_user_id TEXT REFERENCES portal_users(id) ON DELETE SET NULL;
ALTER TABLE deal_files     ADD COLUMN IF NOT EXISTS portal_user_id TEXT REFERENCES portal_users(id) ON DELETE SET NULL;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web';   -- 'web' | 'portal'
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS portal_user_id TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS portal_discount BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS company_id TEXT;
