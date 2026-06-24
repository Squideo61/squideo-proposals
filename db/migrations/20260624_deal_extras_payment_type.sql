-- Extra charges can now be billed three ways, chosen when the extra is added:
--   'final'       — rides the project's final invoice (the existing behaviour)
--   'invoice_now' — its own Xero invoice is raised immediately
--   'po'          — a Xero quote ("Pending PO") is raised; it sits in the deal's
--                   Purchase Orders section until turned into an invoice (which
--                   voids the quote, Xero-style)
--
-- Adds the billing route + the Xero quote link for PO-route extras. The same
-- columns are self-healed at runtime by ensureDealExtrasTable(), so a workspace
-- that skips this apply still works.
ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS payment_type  TEXT NOT NULL DEFAULT 'final';
ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS xero_quote_id TEXT;
ALTER TABLE deal_extras ADD COLUMN IF NOT EXISTS quote_number  TEXT;

-- A PO-route extra awaiting its invoice carries status 'quoted' (between
-- 'pending' and 'invoiced'); it's excluded from the Pending Payments report
-- until the quote becomes an invoice.
