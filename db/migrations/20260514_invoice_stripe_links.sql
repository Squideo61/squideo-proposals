ALTER TABLE manual_invoices ALTER COLUMN blob_url DROP NOT NULL;

ALTER TABLE manual_invoices
  ADD COLUMN IF NOT EXISTS stripe_payment_link_id  TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_link_url TEXT,
  ADD COLUMN IF NOT EXISTS paid_at                 TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_method          TEXT,
  ADD COLUMN IF NOT EXISTS recorded_by             TEXT REFERENCES users(email) ON DELETE SET NULL;
