-- Per-video Script uploads + production milestones.
--
-- A copywriter uploads a script for a video; producers view and approve it.
-- Approving the script (and the other milestones) advances the video card to
-- the next board stage. The script file lands in the deal's Drive "Script and
-- Text Direction" folder (or a private Blob when Drive isn't configured).
--
-- Idempotent. Also self-healed at runtime by ensureProductionSchema() in
-- api/_lib/production.js, so a manual Neon apply is optional.

-- Milestone approvals (a row exists once approved; deleting it un-approves).
CREATE TABLE IF NOT EXISTS video_milestones (
  id          TEXT        PRIMARY KEY,
  video_id    TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
  milestone   TEXT        NOT NULL,   -- script | visual_direction | storyboard | video
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS video_milestones_unique ON video_milestones(video_id, milestone);

-- Uploaded scripts (newest row = current; older rows kept as history).
CREATE TABLE IF NOT EXISTS video_scripts (
  id            TEXT        PRIMARY KEY,
  video_id      TEXT        NOT NULL REFERENCES project_videos(id) ON DELETE CASCADE,
  deal_id       TEXT        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  filename      TEXT        NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT,
  drive_file_id TEXT,
  web_view_link TEXT,
  blob_url      TEXT,
  blob_pathname TEXT,
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS video_scripts_video_idx ON video_scripts(video_id, created_at DESC);
