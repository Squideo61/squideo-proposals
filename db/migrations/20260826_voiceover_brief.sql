-- "Other — describe the voice you want" on the portal's voiceover picker.
--
-- The picker only ever offered a fixed list. That list exists because a HUMAN
-- artist has a real per-voice cost, so the client had to commit to one of the
-- voices we'd actually licensed. An AI voice carries no such cost, so pinning
-- the client to four named voices buys us nothing — they can instead describe
-- the tone, accent and gender they're after and we match it.
--
-- The brief lives on the video alongside voiceover_artist_id and is deliberately
-- NOT an artist row: nothing is licensed or locked yet, and the producer still
-- has to pick a voice to fulfil it. A video therefore settles its voiceover step
-- via EITHER a chosen artist OR a brief, never both — the portal refuses a brief
-- on a video that already has an artist, and vice versa.
--
-- Mirrored by the self-heal in ensureVoiceoverCatalogue() (api/_lib/voiceover.js),
-- so the portal works on an instance where this migration hasn't been run.

ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_brief    TEXT;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_brief_at TIMESTAMPTZ;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS voiceover_brief_by TEXT;

-- The producer-facing question is "which projects are waiting on us to match a
-- voice?", which is a scan for a non-null brief with no artist behind it.
CREATE INDEX IF NOT EXISTS project_videos_voiceover_brief_idx
  ON project_videos (deal_id) WHERE voiceover_brief IS NOT NULL AND voiceover_artist_id IS NULL;
