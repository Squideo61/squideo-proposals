ALTER TABLE project_retainers
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'archived'));

CREATE INDEX IF NOT EXISTS project_retainers_status_idx ON project_retainers(status);
