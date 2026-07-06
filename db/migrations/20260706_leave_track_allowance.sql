-- Decouple "on the schedule" from "annual-leave allowance tracked".
--
-- leave_allowances.active already controls whether someone appears on the
-- Weekly Schedule roster. This adds a separate `track_allowance` flag: when
-- false, the person is still on the schedule (calendar column, assignable,
-- can log days off) but has NO annual-leave allowance counted in the CRM.
-- Used for directors/owners (e.g. Ben Underwood, Adam Shelton) who produce but
-- have separate holiday arrangements. Also self-healed by ensureScheduleTables()
-- in api/_lib/crm/schedule.js.

ALTER TABLE leave_allowances
  ADD COLUMN IF NOT EXISTS track_allowance BOOLEAN NOT NULL DEFAULT TRUE;
