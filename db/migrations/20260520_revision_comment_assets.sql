-- Let a client attach one supporting asset (e.g. a replacement logo) to a
-- revision comment. The file is uploaded to the public revision Blob store and
-- its URL/metadata stored on the comment.
ALTER TABLE revision_comments ADD COLUMN IF NOT EXISTS attachment_url  TEXT;
ALTER TABLE revision_comments ADD COLUMN IF NOT EXISTS attachment_name TEXT;
ALTER TABLE revision_comments ADD COLUMN IF NOT EXISTS attachment_type TEXT;
