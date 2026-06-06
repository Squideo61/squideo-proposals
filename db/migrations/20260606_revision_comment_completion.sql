-- Each individual client comment (a revision request) can be ticked complete by
-- the producer, with its own timestamp. (Supersedes the per-draft completion in
-- 20260606_revision_completion_assignment.sql, whose version columns are left in
-- place but no longer surfaced.) Columns self-heal at runtime.
ALTER TABLE revision_comments   ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE revision_comments   ADD COLUMN IF NOT EXISTS completed_by TEXT;
ALTER TABLE storyboard_comments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE storyboard_comments ADD COLUMN IF NOT EXISTS completed_by TEXT;
