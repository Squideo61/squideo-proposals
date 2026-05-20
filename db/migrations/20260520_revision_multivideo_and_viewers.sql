-- Multiple videos per project: project -> videos -> versions (drafts).
CREATE TABLE IF NOT EXISTS revision_videos (
  id          TEXT        PRIMARY KEY,
  project_id  TEXT        NOT NULL REFERENCES revision_projects(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS revision_videos_project_idx ON revision_videos(project_id, sort_order, created_at);

-- Drafts now hang off a video (project_id kept for cheap project-level counts).
ALTER TABLE revision_versions ADD COLUMN IF NOT EXISTS video_id TEXT REFERENCES revision_videos(id) ON DELETE CASCADE;

-- Backfill: every existing draft belongs to one implicit "Video 1" per project.
INSERT INTO revision_videos (id, project_id, title, sort_order)
  SELECT gen_random_uuid()::text, p.id, 'Video 1', 0
    FROM revision_projects p
   WHERE EXISTS (SELECT 1 FROM revision_versions v WHERE v.project_id = p.id AND v.video_id IS NULL)
     AND NOT EXISTS (SELECT 1 FROM revision_videos rv WHERE rv.project_id = p.id);

UPDATE revision_versions v
   SET video_id = rv.id
  FROM revision_videos rv
 WHERE rv.project_id = v.project_id AND v.video_id IS NULL;

CREATE INDEX IF NOT EXISTS revision_versions_video_idx ON revision_versions(video_id, version_number DESC);

-- Capture who opened a review link (name + email gate). One row per
-- project+email, refreshed on each visit.
CREATE TABLE IF NOT EXISTS revision_viewers (
  id          TEXT        PRIMARY KEY,
  project_id  TEXT        NOT NULL REFERENCES revision_projects(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS revision_viewers_unique ON revision_viewers(project_id, lower(email));
