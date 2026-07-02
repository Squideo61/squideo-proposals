-- Link a retainer work-log entry to the project video it was created for, so a
-- credit-based project's list can show each video as a line item (Active until
-- the video is Signed Off) and deleting the video refunds its credits.
ALTER TABLE project_retainer_entries
  ADD COLUMN IF NOT EXISTS video_id TEXT REFERENCES project_videos(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_retainer_entries_video ON project_retainer_entries(video_id);
