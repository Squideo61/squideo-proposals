-- Track how much has been paid against a proposal-billing Xero invoice (the
-- signed-proposal "email me an invoice" and PO flows). Unlike direct Stripe
-- checkouts (recorded in `payments`), these invoices are paid later in Xero /
-- via the invoice's own pay button, with no row in our payment tables. The
-- invoices GET enrichment reads the live paid figure from Xero and stamps it
-- here so the company balance can subtract it without a Xero round-trip.
ALTER TABLE proposal_billing ADD COLUMN IF NOT EXISTS paid_amount NUMERIC;
ALTER TABLE proposal_billing ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
