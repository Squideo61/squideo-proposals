// Runtime self-heal for db/migrations/20260805_explainer_course.sql.
//
// Deliberately NOT folded into ensurePortalTables(): that one runs at the top
// of every single portal request, and the course is a handful of routes. Keep
// its schema cost on its own routes.
//
// Every step catches and carries on, and the promise is only cached once a run
// completes. A self-heal that rethrows takes out the route it was meant to
// support — see the 2026-07-21 ensureDealReference() outage. If a table really
// is missing the caller's own query fails with a clean error a moment later,
// which is a far better failure than a cascade.

import sql from '../db.js';

const step = async (label, fn) => {
  try { await fn(); } catch (err) { console.warn('[ensureCourseTables] ' + label, err.message); }
};

// Just the two columns on `companies`, on their own.
//
// The CRM's company list filters on `prospect` to keep one-per-signup course
// orgs out of the Organisations tab. That query runs on a hot path that has
// nothing else to do with the course, so it can't pay for the whole
// ensureCourseTables() run — but it also can't reference a column that a
// workspace which never applied the migration doesn't have.
let prospectEnsured = null;
export function ensureProspectColumns() {
  if (prospectEnsured) return prospectEnsured;
  prospectEnsured = (async () => {
    try {
      await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS prospect BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS source TEXT`;
    } catch (err) {
      console.warn('[ensureProspectColumns]', err.message);
    }
  })();
  return prospectEnsured;
}

let courseTablesEnsured = null;
export function ensureCourseTables() {
  if (courseTablesEnsured) return courseTablesEnsured;
  courseTablesEnsured = (async () => {
    await step('course_modules', async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS course_modules (
          id                TEXT        PRIMARY KEY,
          slug              TEXT        NOT NULL UNIQUE,
          module_number     INTEGER     NOT NULL,
          title             TEXT        NOT NULL,
          subtitle          TEXT,
          description       TEXT,
          blob_url          TEXT,
          blob_pathname     TEXT,
          mime_type         TEXT,
          size_bytes        BIGINT,
          duration_seconds  INTEGER,
          poster            TEXT,
          poster_updated_at TIMESTAMPTZ,
          free              BOOLEAN     NOT NULL DEFAULT FALSE,
          published         BOOLEAN     NOT NULL DEFAULT FALSE,
          sort_order        INTEGER,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS course_modules_order_idx
                  ON course_modules ((COALESCE(sort_order, module_number)))`;
    });

    await step('course_progress', async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS course_progress (
          portal_user_id   TEXT        NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
          module_id        TEXT        NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
          furthest_seconds INTEGER     NOT NULL DEFAULT 0,
          seconds_watched  INTEGER     NOT NULL DEFAULT 0,
          duration_seconds INTEGER,
          view_count       INTEGER     NOT NULL DEFAULT 0,
          first_viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_viewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at     TIMESTAMPTZ,
          PRIMARY KEY (portal_user_id, module_id)
        )`;
      await sql`CREATE INDEX IF NOT EXISTS course_progress_user_idx ON course_progress(portal_user_id)`;
    });

    await step('course_signups', async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS course_signups (
          id                TEXT        PRIMARY KEY,
          email             TEXT        NOT NULL,
          name              TEXT,
          company_name      TEXT,
          portal_user_id    TEXT        REFERENCES portal_users(id) ON DELETE SET NULL,
          contact_id        TEXT        REFERENCES contacts(id) ON DELETE SET NULL,
          company_id        TEXT        REFERENCES companies(id) ON DELETE SET NULL,
          marketing_consent BOOLEAN     NOT NULL DEFAULT FALSE,
          consent_text      TEXT,
          consent_ip        TEXT,
          consent_at        TIMESTAMPTZ,
          consent_source    TEXT,
          completed_at      TIMESTAMPTZ,
          hot_notified_at   TIMESTAMPTZ,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS course_signups_email_idx ON course_signups(LOWER(email))`;
      await sql`CREATE INDEX IF NOT EXISTS course_signups_user_idx ON course_signups(portal_user_id)`;
    });

    await step('course_events', async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS course_events (
          id          TEXT        PRIMARY KEY,
          visitor_key TEXT,
          event_key   TEXT        NOT NULL,
          module_id   TEXT,
          detail      JSONB,
          country     TEXT,
          city        TEXT,
          user_agent  TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS course_events_at_idx ON course_events(created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS course_events_key_idx ON course_events(event_key, created_at DESC)`;
    });

    await step('course_signup_throttle', async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS course_signup_throttle (
          ip           TEXT        NOT NULL,
          window_start TIMESTAMPTZ NOT NULL,
          attempts     INTEGER     NOT NULL DEFAULT 1,
          PRIMARY KEY (ip, window_start)
        )`;
    });

    // The same 20 attribution columns quote_requests carries, so a course
    // signup can be written straight from pickAttribution() and read by the
    // same reporting. Kept here rather than generalising ensureLeadAttribution()
    // — that runs on the live quote-request path and isn't worth churning.
    // Written out one per line rather than looped: `sql` is a tagged template,
    // and building DDL by string-concatenating into it is the habit that ends
    // in an injection. Mirrors ensureLeadAttribution() exactly.
    await step('course_signups attribution', async () => {
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_channel       TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_source        TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_medium        TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_campaign      TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_term          TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_content       TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_gclid         TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_gbraid        TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_wbraid        TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_fbclid        TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_msclkid       TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_campaign_id   TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_adgroup_id    TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_keyword       TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_matchtype     TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_network       TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_device        TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_landing_url   TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_referrer      TEXT`;
      await sql`ALTER TABLE course_signups ADD COLUMN IF NOT EXISTS attr_first_seen_at TIMESTAMPTZ`;
      await sql`CREATE INDEX IF NOT EXISTS course_signups_channel_idx ON course_signups(attr_channel)`;
    });

    // Prospect orgs (created by self-serve signup) and the lead-magnet
    // dimension on quote requests. See the migration for why lead_magnet is
    // its own column rather than an attr_channel value.
    await step('columns', async () => {
      await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS prospect BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS source TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS companies_prospect_idx ON companies(prospect) WHERE prospect`;
      await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS lead_magnet TEXT`;
      await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS course_signup_id TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS quote_requests_lead_magnet_idx
                  ON quote_requests(lead_magnet) WHERE lead_magnet IS NOT NULL`;
    });
  })();
  return courseTablesEnsured;
}
