-- Director tax payments: mark paid, then archive (kept for future reference).
-- Apply in the Neon console. Idempotent — safe to re-run.
ALTER TABLE director_tax_payments ADD COLUMN IF NOT EXISTS paid_at  TIMESTAMPTZ;
ALTER TABLE director_tax_payments ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_tax_payments_archived ON director_tax_payments (archived);
