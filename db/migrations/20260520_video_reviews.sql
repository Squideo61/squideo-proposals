-- Video revisions / client review (Frame.io-style).
-- A producer creates a review project, uploads one or more draft video
-- versions, and shares a public link. Clients (no login) play the video and
-- leave timecoded comments.

-- A review project: the container the producer creates and shares.
CREATE TABLE IF NOT EXISTS review_projects (
  id          TEXT        PRIMARY KEY,
  title       TEXT        NOT NULL,
  client_name TEXT,                       -- optional label, producer-set
  share_token TEXT        UNIQUE NOT NULL, -- random, used in the public link
  created_by  TEXT        REFERENCES users(email) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each uploaded draft version of the video.
CREATE TABLE IF NOT EXISTS review_versions (
  id             TEXT        PRIMARY KEY,
  project_id     TEXT        NOT NULL REFERENCES review_projects(id) ON DELETE CASCADE,
  version_number INTEGER     NOT NULL,     -- 1, 2, 3…
  label          TEXT,                      -- e.g. "Draft 01"
  filename       TEXT        NOT NULL,
  mime_type      TEXT,
  size_bytes     BIGINT,
  blob_url       TEXT        NOT NULL,      -- Vercel Blob public URL (for <video>)
  blob_pathname  TEXT,
  uploaded_by    TEXT        REFERENCES users(email) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS review_versions_project_idx
  ON review_versions(project_id, version_number DESC);

-- Timecoded comments. author_name is captured from the public reviewer (or the
-- user's name for internal comments). parent_id allows one level of replies.
CREATE TABLE IF NOT EXISTS review_comments (
  id               TEXT        PRIMARY KEY,
  version_id       TEXT        NOT NULL REFERENCES review_versions(id) ON DELETE CASCADE,
  parent_id        TEXT        REFERENCES review_comments(id) ON DELETE CASCADE,
  timecode_seconds NUMERIC(10,2),          -- null = general comment
  body             TEXT        NOT NULL,
  author_name      TEXT        NOT NULL,
  author_email     TEXT,                    -- set when the comment is from a logged-in user
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS review_comments_version_idx
  ON review_comments(version_id, created_at);
