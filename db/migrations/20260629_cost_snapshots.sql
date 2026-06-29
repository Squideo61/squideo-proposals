-- Monthly CRM-cost snapshots for the Admin "Storage & CRM costs" tab's month
-- stepper. The live tab can only show current figures (Vercel Blob storage and
-- the fixed-cost list are point-in-time; Neon reports the live billing period),
-- so the cost-snapshot cron persists a month-end snapshot here and past months
-- read from these rows. The cost-snapshot cron also creates this table
-- (CREATE TABLE IF NOT EXISTS) so it self-heals if this migration hasn't run.
CREATE TABLE IF NOT EXISTS crm_cost_snapshots (
  month       TEXT PRIMARY KEY,        -- 'YYYY-MM' of the month that ended
  neon_usd    NUMERIC NOT NULL DEFAULT 0,
  blob_usd    NUMERIC NOT NULL DEFAULT 0,
  fixed_usd   NUMERIC NOT NULL DEFAULT 0,
  total_usd   NUMERIC NOT NULL DEFAULT 0,
  breakdown   JSONB,                   -- per-source detail captured at month-end
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
