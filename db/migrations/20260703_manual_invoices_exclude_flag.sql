-- Let admins flag a manual invoice as "not new business" — e.g. a legacy debt we
-- were owed, or any one-off that isn't cash the business generated this period.
-- The invoice stays on record (and in the pending/paid ledgers) but is excluded
-- from the Finance sales / "cash generated" figures. Self-healed by
-- ensureInvoiceExcludeColumn() in api/_lib/crm/invoices.js.
ALTER TABLE manual_invoices
  ADD COLUMN IF NOT EXISTS exclude_from_stats BOOLEAN NOT NULL DEFAULT false;
