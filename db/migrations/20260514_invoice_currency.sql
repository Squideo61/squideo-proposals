-- Currency on uploaded/manual invoices. Xero supports multi-currency invoices
-- and we now capture the currency code + Xero's exchange rate (relative to the
-- org's base currency, GBP) so non-GBP invoices can be displayed natively with
-- a GBP equivalent in brackets.

ALTER TABLE manual_invoices
  ADD COLUMN IF NOT EXISTS currency      TEXT NOT NULL DEFAULT 'GBP',
  ADD COLUMN IF NOT EXISTS currency_rate NUMERIC(18, 6);
