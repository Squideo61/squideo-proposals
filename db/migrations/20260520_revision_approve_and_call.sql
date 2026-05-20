-- Client "Approve Revisions" finalisation + a team booking link for the
-- "Schedule Review Call" button.
ALTER TABLE revision_projects ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE revision_projects ADD COLUMN IF NOT EXISTS approved_by TEXT;

-- Single team-wide booking URL surfaced on the client review page.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS revision_call_url TEXT;
