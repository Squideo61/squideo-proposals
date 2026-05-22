-- Production project-management board. A paid deal becomes a "project": it
-- carries a production phase/stage (mirroring the old Monday.com workflow),
-- a list of videos, a pre-paid credit balance, an assigned producer, and the
-- Monday-style scheduling columns. The deal row IS the project — no separate
-- table — so the existing Deal page doubles as the Project page.
--
-- Idempotent: safe to re-run. Apply manually in the Neon console.

-- ── Production fields on the deal (the project) ──────────────────────────────
ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_phase        TEXT;          -- pre_production | production | completed | after_care (NULL = not in production)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_stage        TEXT;          -- stage id within the phase (e.g. new_project)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_entered_at   TIMESTAMPTZ;   -- when it first entered production
ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_stage_changed_at TIMESTAMPTZ; -- drives "days in stage" on cards
ALTER TABLE deals ADD COLUMN IF NOT EXISTS production_credits      INTEGER NOT NULL DEFAULT 0; -- pre-paid video balance
ALTER TABLE deals ADD COLUMN IF NOT EXISTS producer_email          TEXT REFERENCES users(email) ON DELETE SET NULL; -- assigned producer (sales owner stays owner_email)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS payment_terms           TEXT;          -- 50_50 | full_upfront | po
ALTER TABLE deals ADD COLUMN IF NOT EXISTS delivery_deadline       DATE;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS text_direction_deadline DATE;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS revision_project_id     TEXT;          -- lazily-created Revisions project for this deal (handoff)

CREATE INDEX IF NOT EXISTS deals_production_idx ON deals(production_phase, production_stage)
  WHERE production_phase IS NOT NULL;

-- ── Videos within a project (lightweight production list) ────────────────────
CREATE TABLE IF NOT EXISTS project_videos (
  id                 TEXT        PRIMARY KEY,
  deal_id            TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  title              TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'not_started',  -- per-video production status
  sort_order         INTEGER     NOT NULL DEFAULT 0,
  revision_video_id  TEXT,                                       -- set when "Send for review" links it to Revisions
  created_by         TEXT        REFERENCES users(email) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_videos_deal_idx ON project_videos(deal_id, sort_order, created_at);

-- ── Permission: access the production board ──────────────────────────────────
-- Granted to every role that isn't the wildcard admin and doesn't already have
-- it — including the Producer role, so producers can work the board (today they
-- are limited to revisions.access). Admins keep '*' which implies everything.
UPDATE roles
   SET permissions = permissions || '["production.access"]'::jsonb,
       updated_at  = NOW()
 WHERE NOT (permissions @> '["*"]'::jsonb)
   AND NOT (permissions @> '["production.access"]'::jsonb);
