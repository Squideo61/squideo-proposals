// Runtime self-heal for db/migrations/20260711_customer_portal.sql — the
// customer-portal tables. Called by every portal route (and the CRM portal
// admin) before touching a portal table, so workspaces that haven't applied
// the migration by hand still work. Module-level cached: a successful first
// call short-circuits for the lifetime of the Vercel instance.

import sql from '../db.js';

let portalTablesEnsured = null;
export function ensurePortalTables() {
  if (portalTablesEnsured) return portalTablesEnsured;
  portalTablesEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS portal_users (
        id             TEXT        PRIMARY KEY,
        email          TEXT        NOT NULL UNIQUE,
        name           TEXT,
        phone          TEXT,
        job_title      TEXT,
        password_hash  TEXT,
        contact_id     TEXT        REFERENCES contacts(id) ON DELETE SET NULL,
        token_version  INTEGER     NOT NULL DEFAULT 0,
        disabled_at    TIMESTAMPTZ,
        last_login_at  TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS portal_memberships (
        portal_user_id TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        company_id     TEXT        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        invited_by     TEXT,
        disabled_at    TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (portal_user_id, company_id)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS portal_memberships_company_idx ON portal_memberships(company_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS portal_invites (
        id             TEXT        PRIMARY KEY,
        email          TEXT        NOT NULL,
        company_id     TEXT        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        token_hash     TEXT        NOT NULL UNIQUE,
        prefill        JSONB,
        invited_by     TEXT,
        expires_at     TIMESTAMPTZ NOT NULL,
        accepted_at    TIMESTAMPTZ,
        revoked_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS portal_invites_email_idx ON portal_invites(email)`;
    await sql`CREATE INDEX IF NOT EXISTS portal_invites_company_idx ON portal_invites(company_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS portal_login_tokens (
        id             TEXT        PRIMARY KEY,
        portal_user_id TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        token_hash     TEXT        NOT NULL UNIQUE,
        purpose        TEXT        NOT NULL,
        expires_at     TIMESTAMPTZ NOT NULL,
        used_at        TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS portal_login_tokens_user_idx ON portal_login_tokens(portal_user_id, created_at DESC)`;
    await sql`
      CREATE TABLE IF NOT EXISTS portal_failed_logins (
        email        TEXT        NOT NULL,
        ip           TEXT        NOT NULL,
        attempts     INTEGER     NOT NULL DEFAULT 1,
        first_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (email, ip)
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS portal_company_files (
        id             TEXT        PRIMARY KEY,
        company_id     TEXT        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        category       TEXT        NOT NULL DEFAULT 'brand',
        filename       TEXT        NOT NULL,
        mime_type      TEXT,
        size_bytes     INTEGER,
        blob_url       TEXT        NOT NULL,
        blob_pathname  TEXT,
        uploaded_by_portal_user TEXT REFERENCES portal_users(id) ON DELETE SET NULL,
        uploaded_by_staff       TEXT REFERENCES users(email) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS portal_company_files_idx ON portal_company_files(company_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS portal_extra_offers (
        id                TEXT        PRIMARY KEY,
        deal_id           TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        kind              TEXT        NOT NULL DEFAULT 'custom',
        proposal_extra_id TEXT,
        title             TEXT,
        description       TEXT,
        amount            NUMERIC,
        hidden            BOOLEAN     NOT NULL DEFAULT FALSE,
        created_by        TEXT        REFERENCES users(email) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS portal_extra_offers_deal_idx ON portal_extra_offers(deal_id)`;
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS portal_extras_discount NUMERIC NOT NULL DEFAULT 0.10`;
    await sql`ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff'`;
    await sql`ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS portal_user_id TEXT REFERENCES portal_users(id) ON DELETE SET NULL`;
    await sql`ALTER TABLE deal_files ADD COLUMN IF NOT EXISTS portal_user_id TEXT REFERENCES portal_users(id) ON DELETE SET NULL`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web'`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS portal_user_id TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS portal_discount BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS company_id TEXT`;
  })().catch((err) => { portalTablesEnsured = null; throw err; });
  return portalTablesEnsured;
}
