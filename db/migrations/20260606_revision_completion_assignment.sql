-- Producers can mark each revision draft complete (with a timestamp) and a
-- revision project can be assigned to a producer who didn't make the original
-- video. Columns self-heal at runtime (ensureRevisionFeedbackColumns /
-- ensureStoryboardTables); this migration keeps Neon in lockstep.
ALTER TABLE revision_versions  ADD COLUMN IF NOT EXISTS completed_at   TIMESTAMPTZ;
ALTER TABLE revision_versions  ADD COLUMN IF NOT EXISTS completed_by   TEXT;
ALTER TABLE revision_projects  ADD COLUMN IF NOT EXISTS assignee_email TEXT;

ALTER TABLE storyboard_versions ADD COLUMN IF NOT EXISTS completed_at   TIMESTAMPTZ;
ALTER TABLE storyboard_versions ADD COLUMN IF NOT EXISTS completed_by   TEXT;
ALTER TABLE storyboard_projects ADD COLUMN IF NOT EXISTS assignee_email TEXT;
