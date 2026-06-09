-- Spatial pins on video-revision comments. Mirrors the storyboard comment
-- pinning (anchor_x / anchor_y on storyboard_comments) so a client can pin a
-- note to a specific spot on a paused video frame. Both coords are normalised
-- floats in [0,1]; NULL means "no spatial anchor" (whole-frame / timecode-only).
-- Idempotent — also self-healed at runtime in api/revisions/[action].js.

ALTER TABLE revision_comments ADD COLUMN IF NOT EXISTS anchor_x DOUBLE PRECISION;
ALTER TABLE revision_comments ADD COLUMN IF NOT EXISTS anchor_y DOUBLE PRECISION;
