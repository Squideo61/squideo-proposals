-- Free-text video-length field on projects (deals), shown as the "Length"
-- column on the production board. Free text because Monday's Length holds mixed
-- values like "90s", "1.5m", "606w". Idempotent — apply manually in Neon.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS video_length TEXT;
