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

      // What they asked for after finalising: 'call' or 'quote'. NULL means
      // they haven't said, which is the state most briefs sit in — the panel
      // offering the choice is an offer, not a gate.
      //
      // Worth storing rather than inferring from a booking, because "just send
      // me a number" is a real answer and leaves no other trace. It is also the
      // most useful line in the whole record for whoever picks the lead up: it
      // says how this person wants to be sold to.
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS next_step TEXT`;
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS next_step_at TIMESTAMPTZ`;

      // A brief started from an earlier one. `carried` is the key→value
      // snapshot of what was pre-filled, kept so the form can say "this came
      // from last time, change it if it's different" — and stop saying it the
      // moment the answer no longer matches the snapshot, which needs no extra
      // write and cannot drift.
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS carried_from TEXT`;
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS carried JSONB`;

      // Scrubbed from the Marketing report by a human. Our own accounts and the
      // seeded demo are detected automatically; this is for the ones nothing can
      // infer — a test run under a personal address, a throwaway "test" brief.
      // Non-destructive and reversible: the brief is untouched and still
      // readable, it just stops skewing the lead-magnet conversion rates.
      // See db/migrations/20260826_brief_reporting_exclusions.sql.
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ`;
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS excluded_by TEXT`;

      // Which VIDEO the brief is for. A deal can carry several, and a brief
      // that names only the deal makes the team guess. Unset resolves to the
      // deal's first video — see dealBriefVideos() in ./dealBriefs.js and
      // db/migrations/20260826_brief_video.sql.
      await sql`ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS video_id TEXT`;

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
