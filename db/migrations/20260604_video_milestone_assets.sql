-- Per-milestone content uploads on a video (Script / Visual Direction /
-- Storyboard / Video). Files live in the app Blob store (source of truth) and
-- are best-effort synced to the deal's Drive milestone subfolder. Generalises
-- the earlier video_scripts table to all milestones.
--
-- Idempotent. Also self-healed at runtime by ensureProductionSchema() in
-- api/_lib/production.js.
CREATE TABLE IF NOT EXISTS video_milestone_assets (
  id            TEXT        PRIMARY KEY,
  video_id      TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
  milestone     TEXT        NOT NULL,   -- script | visual_direction | storyboard | video
  filename      TEXT        NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT,
  blob_url      TEXT,
  blob_pathname TEXT,
  drive_file_id TEXT,                   -- set once the best-effort Drive sync completes
  web_view_link TEXT,
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS video_milestone_assets_idx ON video_milestone_assets(video_id, milestone, created_at DESC);

-- Backfill existing scripts so they appear under the Script milestone.
INSERT INTO video_milestone_assets
  (id, video_id, milestone, filename, mime_type, size_bytes, blob_url, blob_pathname, drive_file_id, web_view_link, uploaded_by, created_at)
SELECT gen_random_uuid()::text, vs.video_id, 'script', vs.filename, vs.mime_type, vs.size_bytes,
       vs.blob_url, vs.blob_pathname, vs.drive_file_id, vs.web_view_link, vs.uploaded_by, vs.created_at
  FROM video_scripts vs
 WHERE NOT EXISTS (
   SELECT 1 FROM video_milestone_assets a
    WHERE a.video_id = vs.video_id AND a.milestone = 'script' AND a.filename = vs.filename AND a.created_at = vs.created_at
 );
