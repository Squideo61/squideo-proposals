-- Attach a Xero invoice ID to manually-created CRM invoices so we can
-- record payments in Xero when the team marks them paid, and serve the
-- Xero-rendered PDF via the existing invoice-pdf passthrough.
ALTER TABLE manual_invoices
  ADD COLUMN IF NOT EXISTS xero_invoice_id TEXT;

CREATE INDEX IF NOT EXISTS manual_invoices_xero_idx
  ON manual_invoices(xero_invoice_id)
  WHERE xero_invoice_id IS NOT NULL;
