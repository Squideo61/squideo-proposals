-- Staff override to release a deal's final video before its balance is settled.
-- The final video is normally gated on the deal being paid in full; setting this
-- override releases it early. Mirrored by the self-heal in
-- api/_lib/production.js (ensureProductionSchema).

ALTER TABLE deals ADD COLUMN IF NOT EXISTS final_release_override_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS final_release_override_by TEXT;
