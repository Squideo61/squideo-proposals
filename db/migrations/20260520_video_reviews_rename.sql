-- Rename the video-review tables to "revision" naming for consistency with the
-- product wording ("Revisions"). Renames preserve data, foreign keys and
-- indexes. Idempotent via IF EXISTS: on a fresh install the create migration
-- (20260520_video_reviews.sql) runs first, then this renames; on a re-run the
-- old names no longer exist so each statement is a no-op.
ALTER TABLE IF EXISTS review_projects RENAME TO revision_projects;
ALTER TABLE IF EXISTS review_versions RENAME TO revision_versions;
ALTER TABLE IF EXISTS review_comments RENAME TO revision_comments;

ALTER INDEX IF EXISTS review_versions_project_idx RENAME TO revision_versions_project_idx;
ALTER INDEX IF EXISTS review_comments_version_idx RENAME TO revision_comments_version_idx;
