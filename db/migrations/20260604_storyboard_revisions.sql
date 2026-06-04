-- Storyboard revisions (Frame.io-style PDF review). Parallel to the video
-- revision tables (db/migrations/20260520_revision_*.sql): a producer creates a
-- project, adds one or more storyboards (each a named PDF deliverable), uploads
-- draft PDF versions, and shares a public link. Clients (no login) review the
-- PDF slide-by-slide and leave per-slide and anchored (pin) comments, then
-- approve. Also self-healed at runtime by ensureStoryboardTables() in
-- api/storyboards/[action].js, so a manual Neon apply is optional.

-- The review project: the container the producer creates and shares.
CREATE TABLE IF NOT EXISTS storyboard_projects (
  id          TEXT        PRIMARY KEY,
  title       TEXT        NOT NULL,
  client_name TEXT,
  share_token TEXT        UNIQUE NOT NULL,
  created_by  TEXT        REFERENCES users(email) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by TEXT
);

-- A storyboard within a project (the "video" analog): each is reviewed and
-- approved independently and holds its own draft versions.
CREATE TABLE IF NOT EXISTS storyboards (
  id          TEXT        PRIMARY KEY,
  project_id  TEXT        NOT NULL REFERENCES storyboard_projects(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by TEXT
);
CREATE INDEX IF NOT EXISTS storyboards_project_idx ON storyboards(project_id, sort_order, created_at);

-- Each uploaded draft PDF of a storyboard.
CREATE TABLE IF NOT EXISTS storyboard_versions (
  id             TEXT        PRIMARY KEY,
  project_id     TEXT        NOT NULL REFERENCES storyboard_projects(id) ON DELETE CASCADE,
  storyboard_id  TEXT        NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
  version_number INTEGER     NOT NULL,
  label          TEXT,
  filename       TEXT        NOT NULL,
  mime_type      TEXT,
  size_bytes     BIGINT,
  page_count     INTEGER,                  -- slides in the PDF
  blob_url       TEXT        NOT NULL,      -- Vercel Blob public URL (for pdf.js)
  blob_pathname  TEXT,
  uploaded_by    TEXT        REFERENCES users(email) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS storyboard_versions_project_idx ON storyboard_versions(project_id, version_number DESC);
CREATE INDEX IF NOT EXISTS storyboard_versions_storyboard_idx ON storyboard_versions(storyboard_id, version_number DESC);

-- Comments. page_number is the slide (1-based). anchor_x/anchor_y are the
-- normalized [0,1] pin position on that slide; null = a whole-slide comment.
CREATE TABLE IF NOT EXISTS storyboard_comments (
  id               TEXT        PRIMARY KEY,
  version_id       TEXT        NOT NULL REFERENCES storyboard_versions(id) ON DELETE CASCADE,
  parent_id        TEXT        REFERENCES storyboard_comments(id) ON DELETE CASCADE,
  page_number      INTEGER     NOT NULL DEFAULT 1,
  anchor_x         NUMERIC(6,5),
  anchor_y         NUMERIC(6,5),
  body             TEXT        NOT NULL,
  author_name      TEXT        NOT NULL,
  author_email     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attachment_url   TEXT,
  attachment_name  TEXT,
  attachment_type  TEXT
);
CREATE INDEX IF NOT EXISTS storyboard_comments_version_idx ON storyboard_comments(version_id, page_number, created_at);

-- Who opened a share link (name + email gate). One row per project+email.
CREATE TABLE IF NOT EXISTS storyboard_viewers (
  id          TEXT        PRIMARY KEY,
  project_id  TEXT        NOT NULL REFERENCES storyboard_projects(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS storyboard_viewers_unique ON storyboard_viewers(project_id, lower(email));

-- Per-draft view tracking (who opened which draft, and when).
CREATE TABLE IF NOT EXISTS storyboard_version_views (
  id              TEXT        PRIMARY KEY,
  version_id      TEXT        NOT NULL REFERENCES storyboard_versions(id) ON DELETE CASCADE,
  project_id      TEXT        NOT NULL REFERENCES storyboard_projects(id) ON DELETE CASCADE,
  viewer_name     TEXT,
  viewer_email    TEXT        NOT NULL,
  view_count      INTEGER     NOT NULL DEFAULT 1,
  first_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS storyboard_version_views_unique ON storyboard_version_views(version_id, lower(viewer_email));
CREATE INDEX IF NOT EXISTS storyboard_version_views_project_idx ON storyboard_version_views(project_id);
