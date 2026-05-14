-- VAT breakdown on manual_invoices. `amount` continues to be the gross
-- (inc-VAT) total so existing payment-reconciliation logic stays correct.
-- We add the ex-VAT subtotal and the tax amount so the dashboard can render
-- ex-VAT figures and indicate "No VAT" when applicable.

ALTER TABLE manual_invoices
  ADD COLUMN IF NOT EXISTS subtotal_ex_vat NUMERIC(18, 2),
  ADD COLUMN IF NOT EXISTS tax_amount      NUMERIC(18, 2);
