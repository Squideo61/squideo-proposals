-- Client "Send feedback" for Video + Storyboard revisions.
--
-- 1) Optionally link a revision/storyboard project to a CRM deal so the
--    "feedback submitted" notification can reach that deal's team.
-- 2) Record when a client submits their feedback for a given video/storyboard
--    (per-video, mirroring per-video approval). Drives the notification + the
--    engagement view.
-- 3) Seed role defaults ON for the two new notification keys.
--
-- Idempotent; the column adds are also self-healed at runtime
-- (ensureStoryboardTables in api/storyboards/[action].js, ensureRevisionFeedback
-- in api/revisions/[action].js).

-- Video revisions
ALTER TABLE revision_projects ADD COLUMN IF NOT EXISTS deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE revision_videos   ADD COLUMN IF NOT EXISTS feedback_submitted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS revision_projects_deal_idx ON revision_projects(deal_id);

-- Storyboard revisions
ALTER TABLE storyboard_projects ADD COLUMN IF NOT EXISTS deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE storyboards         ADD COLUMN IF NOT EXISTS feedback_submitted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS storyboard_projects_deal_idx ON storyboard_projects(deal_id);

-- Seed role notification defaults ON (per-user overrides still win). The deal
-- team can be any role, so default these on everywhere.
UPDATE roles
   SET notification_defaults = jsonb_set(notification_defaults, '{revision.feedback_submitted}', 'true', true),
       updated_at = NOW()
 WHERE NOT (notification_defaults ? 'revision.feedback_submitted');

UPDATE roles
   SET notification_defaults = jsonb_set(notification_defaults, '{storyboard.feedback_submitted}', 'true', true),
       updated_at = NOW()
 WHERE NOT (notification_defaults ? 'storyboard.feedback_submitted');
