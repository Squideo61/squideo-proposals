-- Which AI voiceover artist's sample clip plays on the client proposal, under
-- the "Latest-generation AI voiceover artist" inclusion.
--   { "artistId": "<voiceover_artists.id>" | null }
-- null (or an unset column) falls back to the AI artist named Alexander, then
-- to the first AI artist that has a sample. A proposal can override it in the
-- builder (data.voiceoverSample) without touching this.
-- Mirrored by the self-heal in api/settings.js.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS proposal_voiceover JSONB;
