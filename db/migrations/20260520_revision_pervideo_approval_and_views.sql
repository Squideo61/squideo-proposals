-- Approval moves to per-video (a project can have many videos, each reviewed
-- and approved independently). Backfill from the old project-level approval.
ALTER TABLE revision_videos ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE revision_videos ADD COLUMN IF NOT EXISTS approved_by TEXT;

UPDATE revision_videos rv
   SET approved_at = p.approved_at, approved_by = p.approved_by
  FROM revision_projects p
 WHERE p.id = rv.project_id AND p.approved_at IS NOT NULL AND rv.approved_at IS NULL;

-- Per-draft view tracking (who opened which draft, and when) — like proposal views.
CREATE TABLE IF NOT EXISTS revision_version_views (
  id              TEXT        PRIMARY KEY,
  version_id      TEXT        NOT NULL REFERENCES revision_versions(id) ON DELETE CASCADE,
  project_id      TEXT        NOT NULL REFERENCES revision_projects(id) ON DELETE CASCADE,
  viewer_name     TEXT,
  viewer_email    TEXT        NOT NULL,
  view_count      INTEGER     NOT NULL DEFAULT 1,
  first_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS revision_version_views_unique ON revision_version_views(version_id, lower(viewer_email));
CREATE INDEX IF NOT EXISTS revision_version_views_project_idx ON revision_version_views(project_id);
