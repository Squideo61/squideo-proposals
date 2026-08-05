// Runtime self-heal for db/migrations/20260711_customer_portal.sql — the
// customer-portal tables. Called by every portal route (and the CRM portal
// admin) before touching a portal table, so workspaces that haven't applied
// the migration by hand still work. Module-level cached: a successful first
// call short-circuits for the lifetime of the Vercel instance.

import sql from '../db.js';
import { ensureCompanyLogoColumns } from './logo.js';

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
    // Client-facing notification feed (db/migrations/20260728_portal_notifications.sql).
    await sql`
      CREATE TABLE IF NOT EXISTS portal_notifications (
        id               TEXT        PRIMARY KEY,
        portal_user_id   TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        company_id       TEXT        REFERENCES companies(id) ON DELETE CASCADE,
        deal_id          TEXT,
        notification_key TEXT,
        title            TEXT        NOT NULL,
        body             TEXT,
        link             TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        read_at          TIMESTAMPTZ
      )`;
    await sql`CREATE INDEX IF NOT EXISTS portal_notifications_user_idx ON portal_notifications(portal_user_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS portal_notifications_unread_idx ON portal_notifications(portal_user_id) WHERE read_at IS NULL`;
    // Append-only log of client portal activity that has no home on a domain
    // table — chiefly LOGINS (last_login_at only keeps the latest). Action
    // events (uploads, voiceover picks, payments…) are read from their own
    // authoritative timestamp columns, so they're deliberately NOT duplicated
    // here. See db/migrations/20260728_portal_activity.sql.
    await sql`
      CREATE TABLE IF NOT EXISTS portal_activity (
        id             TEXT        PRIMARY KEY,
        portal_user_id TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        company_id     TEXT        REFERENCES companies(id) ON DELETE SET NULL,
        deal_id        TEXT,
        event_key      TEXT        NOT NULL,
        detail         JSONB,
        ip             TEXT,
        country        TEXT,
        region         TEXT,
        city           TEXT,
        user_agent     TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS portal_activity_user_idx ON portal_activity(portal_user_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS portal_activity_company_idx ON portal_activity(company_id, created_at DESC)`;
    // Past work added to the client's video library by staff, alongside the two
    // live sources (delivered cuts + Drive "Signed Off").
    // See db/migrations/20260730_portal_library.sql.
    await sql`
      CREATE TABLE IF NOT EXISTS portal_library_items (
        id            TEXT        PRIMARY KEY,
        company_id    TEXT        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        deal_id       TEXT        REFERENCES deals(id) ON DELETE SET NULL,
        title         TEXT        NOT NULL,
        filename      TEXT,
        mime_type     TEXT,
        size_bytes    BIGINT,
        blob_url      TEXT        NOT NULL,
        blob_pathname TEXT,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS portal_library_items_company_idx ON portal_library_items(company_id, created_at DESC)`;
    // Free-text series name; when set it decides the library group.
    await sql`ALTER TABLE portal_library_items ADD COLUMN IF NOT EXISTS series TEXT`;
    // Thumbnail captured from a frame of the video itself.
    await sql`ALTER TABLE portal_library_items ADD COLUMN IF NOT EXISTS poster TEXT`;
    await sql`ALTER TABLE portal_library_items ADD COLUMN IF NOT EXISTS poster_updated_at TIMESTAMPTZ`;
    // Hand-set running order within a library group (NULL = newest-first).
    await sql`ALTER TABLE portal_library_items ADD COLUMN IF NOT EXISTS sort_order INTEGER`;
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS portal_extras_discount NUMERIC NOT NULL DEFAULT 0.10`;
    await sql`ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff'`;
    await sql`ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS portal_user_id TEXT REFERENCES portal_users(id) ON DELETE SET NULL`;
    await sql`ALTER TABLE deal_files ADD COLUMN IF NOT EXISTS portal_user_id TEXT REFERENCES portal_users(id) ON DELETE SET NULL`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web'`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS portal_user_id TEXT`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS portal_discount BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS company_id TEXT`;
    // Video Credit: a "New video" request can flag that the client wants to
    // spend their credit balance (db/migrations/20260728_video_credit.sql).
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS use_credit BOOLEAN NOT NULL DEFAULT FALSE`;
    // Script & visual direction — the client's own upload stage
    // (db/migrations/20260730_client_script.sql). script_status: NULL = waiting,
    // 'received' = we have it, 'squideo' = they've asked us to write it.
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS script_status TEXT`;
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS script_status_at TIMESTAMPTZ`;
    await sql`ALTER TABLE deals ADD COLUMN IF NOT EXISTS script_status_by TEXT`;
    await sql`ALTER TABLE deal_files ADD COLUMN IF NOT EXISTS category TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS deal_files_category_idx ON deal_files(deal_id, category)`;
    // Portal accounts that are ours, not a client's — see
    // db/migrations/20260809_portal_internal_accounts.sql. Not the same as
    // disabled: these are live logins we keep using, they just aren't leads.
    await sql`ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS internal BOOLEAN NOT NULL DEFAULT FALSE`;
    // Partner Programme enquiries — what they want and when they're free,
    // rather than a booked calendar slot. See
    // db/migrations/20260808_partner_enquiries.sql for why.
    await sql`
      CREATE TABLE IF NOT EXISTS partner_enquiries (
        id                TEXT        PRIMARY KEY,
        company_id        TEXT        REFERENCES companies(id) ON DELETE CASCADE,
        portal_user_id    TEXT,
        minutes_per_month TEXT,
        preferred_date    DATE,
        preferred_time    TEXT,
        note              TEXT,
        handled_at        TIMESTAMPTZ,
        handled_by        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS partner_enquiries_company_idx ON partner_enquiries (company_id, created_at DESC)`;
    // companies.logo — the org's own brand mark. Must exist before the session
    // queries below read it (db/migrations/20260730_company_logo.sql).
    await ensureCompanyLogoColumns();
  })().catch((err) => { portalTablesEnsured = null; throw err; });
  return portalTablesEnsured;
}
