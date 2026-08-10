-- Per-draft approval locking for storyboards.
--
-- storyboards.approved_at used to lock every draft in the storyboard, so putting
-- a new draft in front of the client meant clearing the approval — reopening the
-- draft they had already signed off. approved_version records WHICH draft they
-- approved: that draft and everything before it stay locked, anything newer is
-- open for comments.
ALTER TABLE storyboards ADD COLUMN IF NOT EXISTS approved_version INT;

-- Existing approvals covered whatever the client could see at the time.
UPDATE storyboards sb
   SET approved_version = COALESCE(sb.client_submitted_version,
         (SELECT MAX(version_number) FROM storyboard_versions WHERE storyboard_id = sb.id))
 WHERE sb.approved_at IS NOT NULL AND sb.approved_version IS NULL;
