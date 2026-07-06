-- Manual ad-hoc blocks on the Staff Production Rota (Callum's "+" button).
--
-- A manual block isn't tied to a video/deal — it just fills a producer's day(s)
-- with a named card. Relax the FK columns to nullable and add a title. Also
-- self-healed by ensureScheduleTables() in api/_lib/crm/schedule.js.

ALTER TABLE schedule_assignments ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE schedule_assignments ALTER COLUMN video_id DROP NOT NULL;
ALTER TABLE schedule_assignments ALTER COLUMN deal_id DROP NOT NULL;
