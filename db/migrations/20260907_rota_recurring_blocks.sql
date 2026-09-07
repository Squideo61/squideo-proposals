-- Repeating rota blocks + capacity exclusions (Callum's "Rota changes", Sept 2026).
--
-- 1. A block series is a weekly rule ("every Monday and Friday, from X, forever")
--    that materialises into ordinary one-day manual blocks. Keeping occurrences as
--    real schedule_assignments rows means the packer's occupancy map, drag/drop,
--    conflicts and deletion all work unchanged.
CREATE TABLE IF NOT EXISTS schedule_block_series (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  title TEXT NOT NULL,
  weekdays SMALLINT[] NOT NULL,          -- ISO day numbers, 1 = Mon … 5 = Fri
  start_date DATE NOT NULL,
  end_date DATE,                          -- NULL = repeats indefinitely
  skips DATE[] NOT NULL DEFAULT '{}',     -- occurrences deleted or moved on their own
  materialised_to DATE,                   -- how far ahead rows have been written
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS schedule_block_series_user_idx ON schedule_block_series (user_email);

ALTER TABLE schedule_assignments ADD COLUMN IF NOT EXISTS series_id TEXT;
-- NULLs are distinct in a unique index, so ad-hoc (non-series) blocks are
-- unaffected while a series can only ever have one block per day.
CREATE UNIQUE INDEX IF NOT EXISTS schedule_assignments_series_day_uidx
  ON schedule_assignments (series_id, start_date);

-- 2. People who sit on the rota but shouldn't move the utilisation figures —
--    part-time production, test accounts. NULL/TRUE = counted, FALSE = not.
ALTER TABLE leave_allowances ADD COLUMN IF NOT EXISTS counts_capacity BOOLEAN NOT NULL DEFAULT TRUE;
-- Per-row guard for the one-time seed of the requested column order + exclusions.
ALTER TABLE leave_allowances ADD COLUMN IF NOT EXISTS rota_layout_seeded BOOLEAN NOT NULL DEFAULT FALSE;
