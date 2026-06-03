-- Let an invoice be scoped directly to a company, not just a deal/proposal, so
-- the company page can list and create invoices against the company's linked
-- Xero contact. Idempotent.

ALTER TABLE manual_invoices ADD COLUMN IF NOT EXISTS company_id TEXT;
CREATE INDEX IF NOT EXISTS idx_manual_invoices_company_id ON manual_invoices(company_id);
