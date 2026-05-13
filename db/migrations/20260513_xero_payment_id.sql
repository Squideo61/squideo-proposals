ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS xero_payment_id TEXT;

ALTER TABLE partner_invoices
  ADD COLUMN IF NOT EXISTS xero_payment_id TEXT;
