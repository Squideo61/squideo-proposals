-- The video brief becomes a COLLABORATIVE, job-aware document.
--
-- Three things changed about how briefs are actually used:
--
--  1. One person no longer fills it in. A brief needs the marketing lead, the
--     person who knows the product and whoever holds the budget, so it has to
--     be shared by the ORGANISATION, not owned by whoever opened it first.
--  2. It was built as a lead magnet, but clients started sending briefs AFTER
--     signing — so a brief has to be able to say which job it is for.
--  3. Once it's agreed it must stop moving, or production works from a
--     document that changed after they read it.
--
-- NOTHING HERE DESTROYS OR REWRITES AN EXISTING ROW. Every statement is either
-- an added column, an added table, or an added index. The old per-user unique
-- index is dropped rather than replaced: an org whose people each started their
-- own draft has several open briefs today, and a new unique constraint would
-- either fail outright or force us to merge (i.e. discard) somebody's answers.
-- Those legacy drafts stay exactly as they are and are all listed in the portal;
-- the "one open brief per job" rule is enforced when CREATING one instead.
--
-- Self-healed at runtime by ensureClientBriefs() in api/_lib/brief/db.js.

-- ── client_briefs: new columns ───────────────────────────────────────────────
-- A brief people share needs a name to tell it from the others.
ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS title TEXT;
-- Who pressed send/finalise. submitted_at already records WHEN; on a shared
-- document "who" is the interesting half.
ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS submitted_by TEXT;
-- Staff can put a finalised brief back into play (scope genuinely changes).
-- Kept as its own column so "was reopened" survives the next finalise.
ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS reopened_by TEXT;
-- Cheap read for "3 people are on this brief" without touching the events table.
ALTER TABLE client_briefs ADD COLUMN IF NOT EXISTS contributor_count INTEGER NOT NULL DEFAULT 1;

-- ── one open brief per job, enforced at creation, not by the schema ──────────
DROP INDEX IF EXISTS client_briefs_open_idx;
CREATE INDEX IF NOT EXISTS client_briefs_open_company_idx
  ON client_briefs (company_id, updated_at DESC)
  WHERE submitted_at IS NULL;
CREATE INDEX IF NOT EXISTS client_briefs_deal_idx ON client_briefs (deal_id)
  WHERE deal_id IS NOT NULL;

-- ── who changed what ─────────────────────────────────────────────────────────
-- Append-only. actor_name is denormalised on purpose: the feed has to still
-- read "Priya answered the audience question" after Priya's account is gone.
CREATE TABLE IF NOT EXISTS client_brief_events (
  id             TEXT        PRIMARY KEY,
  brief_id       TEXT        NOT NULL REFERENCES client_briefs(id) ON DELETE CASCADE,
  portal_user_id TEXT,
  staff_email    TEXT,
  actor_name     TEXT,
  -- brief.created | brief.attached | answer.changed | answer.cleared
  -- brief.finalised | brief.reopened
  event_key      TEXT        NOT NULL,
  question_key   TEXT,
  question_label TEXT,
  -- Kept so the feed can say what it was before, and so an accidental
  -- overwrite is recoverable by reading rather than by restoring a backup.
  before_value   JSONB,
  after_value    JSONB,
  -- Set once this event has been included in a digest email, so the hourly
  -- sweep never mails the same change twice.
  digested_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_brief_events_brief_idx
  ON client_brief_events (brief_id, created_at DESC);
CREATE INDEX IF NOT EXISTS client_brief_events_pending_idx
  ON client_brief_events (created_at) WHERE digested_at IS NULL;

-- ── who is typing right now ──────────────────────────────────────────────────
-- One row per person per brief, overwritten by each heartbeat. Rows are never
-- deleted on leave — "active" is a time window (last_seen_at), so a closed
-- laptop expires on its own rather than needing a goodbye request that a
-- crashed tab would never send.
CREATE TABLE IF NOT EXISTS client_brief_presence (
  brief_id       TEXT        NOT NULL REFERENCES client_briefs(id) ON DELETE CASCADE,
  portal_user_id TEXT        NOT NULL,
  actor_name     TEXT,
  question_key   TEXT,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brief_id, portal_user_id)
);
CREATE INDEX IF NOT EXISTS client_brief_presence_seen_idx
  ON client_brief_presence (brief_id, last_seen_at DESC);

-- ── backfill, additively ─────────────────────────────────────────────────────
-- Existing briefs get a title so they render in a list rather than as a row of
-- "Untitled". Uses the answer the client already gave; never invents one.
UPDATE client_briefs
   SET title = NULLIF(TRIM(answers->>'projectName'), '')
 WHERE title IS NULL;

-- Every pre-existing brief was written by exactly one person, and that's a real
-- fact about it — seed the event feed with it so the activity panel isn't blank
-- on a brief that predates this feature.
INSERT INTO client_brief_events (id, brief_id, portal_user_id, actor_name, event_key, created_at)
SELECT 'cbe_' || b.id, b.id, b.portal_user_id,
       COALESCE(pu.name, pu.email, 'Someone'), 'brief.created', b.created_at
  FROM client_briefs b
  LEFT JOIN portal_users pu ON pu.id = b.portal_user_id
 WHERE NOT EXISTS (SELECT 1 FROM client_brief_events e WHERE e.brief_id = b.id);

UPDATE client_briefs SET submitted_by = portal_user_id
 WHERE submitted_at IS NOT NULL AND submitted_by IS NULL;
