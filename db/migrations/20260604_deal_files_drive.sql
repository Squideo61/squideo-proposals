-- Deal files can be backed by Google Drive (a per-deal folder in a shared Team
-- Drive) instead of Vercel Blob, switched on by the DEAL_DRIVE_ROOT_ID env var.
-- Drive-backed rows carry the Drive file id + a web view link, and blob_url is
-- left null — so the NOT NULL constraint is relaxed.
ALTER TABLE deal_files ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
ALTER TABLE deal_files ADD COLUMN IF NOT EXISTS web_view_link TEXT;
ALTER TABLE deal_files ALTER COLUMN blob_url DROP NOT NULL;

-- Cache the deal's Drive folder id so we don't look it up on every upload.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS drive_folder_id TEXT;
