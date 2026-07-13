-- "Update rota" (reflow): client-delay flag + undo point.
--
-- client_delayed: the block was pushed back because the CLIENT wasn't ready
-- (their visuals/production weren't signed off in time). Slipping past the
-- delivery date is then the client's doing, not a production clash — so these
-- blocks never raise a scheduling conflict.
--
-- schedule_reflow_undo: the pre-change rows from the last "Update rota" press,
-- so a manager can put the rota back exactly as it was. Only the most recent
-- reflow is retained, so Undo can never replay a stale snapshot over newer work.
--
-- Also applied at runtime by ensureScheduleTables() in api/_lib/crm/schedule.js.

ALTER TABLE schedule_assignments ADD COLUMN IF NOT EXISTS client_delayed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS schedule_reflow_undo (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL DEFAULT 'all',   -- 'all' or a producer's email
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot   JSONB NOT NULL                 -- array of pre-change schedule_assignments rows
);
