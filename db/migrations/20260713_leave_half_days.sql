-- Half-day annual leave.
--
-- A half day is a single date taken as a morning ('am') or an afternoon ('pm')
-- and counts 0.5 against the allowance. `leave_requests.days` is already NUMERIC,
-- so the allowance maths (SUM(days) over the leave year) needs no change.
--
-- A half day does NOT take the producer off the rota — they still work the other
-- half — so loadOccupancy() skips half days when building the packer's occupied
-- day set. It is still drawn on the calendar and still raises the overlap
-- warning, and it never triggers leave coverage.
--
-- Also applied at runtime by ensureScheduleTables() in api/_lib/crm/schedule.js.

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS half_day BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS half_period TEXT;
