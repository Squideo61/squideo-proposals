-- A short "project overview" video link (e.g. Loom) the deal owner records for
-- producers to watch before digesting the rest of the deal. Shown top-right on
-- the deal page. Idempotent; also self-healed at runtime by
-- ensureDealFileDriveColumns() in api/_lib/crm/deals.js.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS overview_video_url TEXT;
