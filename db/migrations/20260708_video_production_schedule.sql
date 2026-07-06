-- Per-video production schedule.
--
-- The production schedule used to live only on the deal, which is misleading for
-- multi-video projects (one video delivered ≠ the whole project done). Each
-- video now carries its own visuals/production timeline; the deal keeps an
-- optional overall schedule. Also self-healed by ensureProductionSchema() in
-- api/_lib/production.js.

ALTER TABLE project_videos ADD COLUMN IF NOT EXISTS production_schedule JSONB;
