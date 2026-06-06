-- Internal producer note on a revision/storyboard comment: for the team's own
-- reference (never shown to the client). A summary of these notes is included in
-- the "draft complete" notification to PMs/admins. Columns self-heal at runtime.
ALTER TABLE revision_comments   ADD COLUMN IF NOT EXISTS producer_note TEXT;
ALTER TABLE storyboard_comments ADD COLUMN IF NOT EXISTS producer_note TEXT;
