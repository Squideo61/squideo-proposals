-- Link a partner subscription to a Xero contact so that when a recurring Xero
-- invoice for that contact is paid (card via Xero's Stripe link, or BACS), the
-- Xero webhook auto-adds the month's credits. xero_invoice_reference (optional)
-- scopes matching to invoices whose Reference contains it — lets you exclude
-- one-off project invoices to the same contact and only credit the recurring one.
ALTER TABLE partner_subscriptions ADD COLUMN IF NOT EXISTS xero_contact_id        TEXT;
ALTER TABLE partner_subscriptions ADD COLUMN IF NOT EXISTS xero_invoice_reference TEXT;
CREATE INDEX IF NOT EXISTS partner_subscriptions_xero_contact_idx
  ON partner_subscriptions(xero_contact_id);

-- source_ref makes credit movements idempotent. The Xero weblook can fire the
-- same INVOICE update event more than once (and retries on any non-2xx), so we
-- tag each auto-credit with a stable key (e.g. 'xero:<invoiceId>:<subId>') and
-- INSERT ... ON CONFLICT DO NOTHING. Manual movements leave it NULL.
ALTER TABLE credit_allocations ADD COLUMN IF NOT EXISTS source_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS credit_allocations_source_ref_unique
  ON credit_allocations(source_ref) WHERE source_ref IS NOT NULL;
