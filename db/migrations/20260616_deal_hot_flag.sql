-- "Hot" flag on deals: an orthogonal warm-lead marker that can be set at ANY
-- pipeline stage (separate from the Interested stage, which is a single funnel
-- position). Drives the pipeline's flame toggle + "Hot only" filter so you can
-- see every keen deal together regardless of where it sits in the funnel.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS hot BOOLEAN NOT NULL DEFAULT FALSE;
