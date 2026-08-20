-- A client paying the invoice we raised for their proposal used to tell nobody.
--
-- The "send me an invoice instead" route takes a signed client off the card
-- path: the invoice is raised in Xero, they pay it (often from the pay-by-card
-- link on the invoice itself) and the money lands in Xero, never in `payments`.
-- Everything downstream still worked — the deal advanced to 'paid', the
-- "Deposit paid" pill appeared, the balance was right — so nothing looked
-- broken. It just happened in silence.
--
-- We find out two ways and either can be first: the Xero webhook pushing the
-- PAID event, or the invoices page syncing paid_amount when someone opens it.
-- This column is the claim that decides which one gets to send: it's taken in a
-- single conditional UPDATE, so a Xero retry or a second page load can't
-- announce the same payment twice.
--
-- Self-healed at runtime by ensurePaidNotifyColumn() in
-- api/_lib/crm/proposalInvoicePaid.js.

ALTER TABLE proposal_billing ADD COLUMN IF NOT EXISTS paid_notified_at TIMESTAMPTZ;

-- Invoices already paid before this existed are back-stamped as notified.
-- Without this, the next Xero webhook or invoices-page load would fire a fresh
-- "invoice paid" alert for every historical invoice at once.
UPDATE proposal_billing
   SET paid_notified_at = COALESCE(paid_at, updated_at, NOW())
 WHERE paid_notified_at IS NULL
   AND paid_amount IS NOT NULL
   AND paid_amount > 0;
