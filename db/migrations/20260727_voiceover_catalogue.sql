-- Voiceover artist catalogue + per-video client selection.
--
-- Replaces the old squideo.com/squideo-voiceovers SoundCloud page: the client
-- now auditions and picks a voice inside the customer portal, per video, as one
-- of their "project tasks". The catalogue is GLOBAL (the same set of artists for
-- every project), split into two sections matching the marketing page:
--   category = 'ai'    → Latest-Generation AI Voiceovers (Dan, Alexander, …)
--   category = 'human' → Professional Voiceover Artists  (UK Female Corporate, …)
-- One sample clip per artist, stored in private Vercel Blob and streamed back
-- through /api (blob is private-only). Artists are soft-archived, never deleted,
-- so a video that already points at one always resolves its name.
--
-- Apply in the Neon console. The API self-heals both this table
-- (ensureVoiceoverCatalogue in api/_lib/voiceover.js) and the project_videos
-- columns (ensureProductionSchema in api/_lib/production.js), so this migration
-- is idempotent and safe to run late.

CREATE TABLE IF NOT EXISTS voiceover_artists (
  id            TEXT        PRIMARY KEY,
  category      TEXT        NOT NULL DEFAULT 'human',   -- 'ai' | 'human'
  name          TEXT        NOT NULL,
  description   TEXT,
  blob_url      TEXT,
  blob_pathname TEXT,
  mime_type     TEXT,
  size_bytes    BIGINT,
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  archived_at   TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS voiceover_artists_list_idx
    ON voiceover_artists (category, sort_order, created_at);

-- The client's pick, one per video. A non-null artist id = locked (the client
-- confirmed it and can no longer change it from the portal).
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_artist_id  TEXT;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_selected_at TIMESTAMPTZ;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_selected_by TEXT;   -- portal_users.id
