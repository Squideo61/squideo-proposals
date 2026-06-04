-- Link a video (and its deal) to a storyboard in the Storyboard Revisions
-- section, mirroring the existing video-revisions hand-off (revision_project_id
-- / revision_video_id). Lets the video page preview the latest storyboard PDF.
-- Idempotent; also self-healed by ensureProductionSchema() in api/_lib/production.js.
ALTER TABLE deals          ADD COLUMN IF NOT EXISTS storyboard_project_id TEXT;
ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS storyboard_id         TEXT;
