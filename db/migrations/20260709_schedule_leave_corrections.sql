-- Rota / annual-leave enhancements (also self-healed by ensureScheduleTables in
-- api/_lib/crm/schedule.js, so this runs without a manual Neon apply).
--
-- 1. Cover blocks: when a named team member takes leave, someone else's rota is
--    auto-filled with a labelled block tied to that leave request (kind='cover').
-- 2. Opening leave balance: days used before the app started tracking, plus a
--    one-time guard so the production manager's opening figures apply just once.

ALTER TABLE schedule_assignments ADD COLUMN IF NOT EXISTS cover_leave_id TEXT;

ALTER TABLE leave_allowances ADD COLUMN IF NOT EXISTS taken_adjustment    NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE leave_allowances ADD COLUMN IF NOT EXISTS corrections_applied BOOLEAN NOT NULL DEFAULT FALSE;
