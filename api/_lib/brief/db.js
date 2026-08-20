// Runtime self-heal for the brief tables, mirroring
// db/migrations/20260805_client_briefs.sql and
// db/migrations/20260821_collaborative_briefs.sql.
//
// Like every ensure*() here it must RESOLVE on failure, never reject — a
// permissions error on a CREATE TABLE IF NOT EXISTS once took the whole CRM
// down with a 500, and the fix is that these are best-effort by construction.

import sql from '../db.js';

let ensured = null;
export function ensureClientBriefs() {
  if (ensured) return ensured;
  ensured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS client_briefs (
          id               TEXT        PRIMARY KEY,
          portal_user_id   TEXT        NOT NULL,
          company_id       TEXT,
          deal_id          TEXT,
          answers          JSONB       NOT NULL DEFAULT '{}'::jsonb,
          completed_at     TIMESTAMPTZ,
          submitted_at     TIMESTAMPTZ,
          quote_request_id TEXT,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      // Collaboration columns. Separate statements so an older database that
      // already has some of them still picks up the rest.
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS title TEXT`;
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS submitted_by TEXT`;
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ`;
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS reopened_by TEXT`;
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS contributor_count INTEGER NOT NULL DEFAULT 1`;

      // A brief belongs to the ORGANISATION now, so the old "one open draft per
      // person" rule is wrong — and dropping it is safe in a way that replacing
      // it wouldn't be: an org whose people each started a draft has several
      // open briefs, and a new unique index would fail or force a merge.
      await sql`DROP INDEX IF EXISTS client_briefs_open_idx`;
      await sql`CREATE INDEX IF NOT EXISTS client_briefs_open_company_idx
                  ON client_briefs (company_id, updated_at DESC) WHERE submitted_at IS NULL`;
      await sql`CREATE INDEX IF NOT EXISTS client_briefs_deal_idx
                  ON client_briefs (deal_id) WHERE deal_id IS NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS client_briefs_company_idx ON client_briefs (company_id)`;
      await sql`CREATE INDEX IF NOT EXISTS client_briefs_updated_idx ON client_briefs (updated_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS client_brief_events (
          id             TEXT        PRIMARY KEY,
          brief_id       TEXT        NOT NULL REFERENCES client_briefs(id) ON DELETE CASCADE,
          portal_user_id TEXT,
          staff_email    TEXT,
          actor_name     TEXT,
          event_key      TEXT        NOT NULL,
          question_key   TEXT,
          question_label TEXT,
          before_value   JSONB,
          after_value    JSONB,
          digested_at    TIMESTAMPTZ,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS client_brief_events_brief_idx
                  ON client_brief_events (brief_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS client_brief_events_pending_idx
                  ON client_brief_events (created_at) WHERE digested_at IS NULL`;

      await sql`
        CREATE TABLE IF NOT EXISTS client_brief_presence (
          brief_id       TEXT        NOT NULL REFERENCES client_briefs(id) ON DELETE CASCADE,
          portal_user_id TEXT        NOT NULL,
          actor_name     TEXT,
          question_key   TEXT,
          last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (brief_id, portal_user_id)
        )`;
      await sql`CREATE INDEX IF NOT EXISTS client_brief_presence_seen_idx
                  ON client_brief_presence (brief_id, last_seen_at DESC)`;
    } catch (err) {
      console.warn('[clientBriefs] ensure failed', err.message);
    }
  })();
  return ensured;
}
