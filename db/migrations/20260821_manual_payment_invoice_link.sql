-- One payment, counted twice.
--
-- When a client pays a Xero invoice by BACS, the bank tells nobody. So the team
-- records it in the CRM by hand the same day — which is right, and has to keep
-- working, because the CRM cannot see the bank. Days later Xero reconciles and
-- we stamp proposal_billing.paid_amount from it.
--
-- Both are now records of the same £2,000, and every "how much has this deal
-- paid" query added them together. manual_payments already guards against this
-- for MANUAL invoices (manual_invoice_id IS NULL) — there was simply no
-- equivalent for the Xero invoices we raise off a proposal.
--
-- The fix is a link, not a rule about which source wins: a hand-recorded
-- payment can now say which invoice it settles.
ALTER TABLE manual_payments ADD COLUMN IF NOT EXISTS xero_invoice_id TEXT;
CREATE INDEX IF NOT EXISTS manual_payments_xero_invoice_idx
  ON manual_payments (xero_invoice_id) WHERE xero_invoice_id IS NOT NULL;

-- WHICH MANUAL PAYMENTS COUNT — defined once, because it's read from about a
-- dozen places (the deal page, the pipeline pills, company balances, Finance,
-- commission) and twelve copies of a money rule is twelve chances to drift.
--
-- A linked payment KEEPS COUNTING until Xero confirms the invoice. That's the
-- whole point: recording a BACS payment by hand exists so the money shows up
-- immediately, and excluding it the moment it's linked would make the deal read
-- £0 paid until Xero caught up — worse than the bug being fixed. Once
-- paid_amount lands, Xero's figure takes over and the hand-recorded one steps
-- aside.
CREATE OR REPLACE VIEW manual_payments_counted AS
  SELECT mp.*
    FROM manual_payments mp
    LEFT JOIN proposal_billing pb ON pb.xero_invoice_id = mp.xero_invoice_id
   WHERE mp.manual_invoice_id IS NULL
     AND (mp.xero_invoice_id IS NULL OR COALESCE(pb.paid_amount, 0) <= 0);

-- Backfill, but only where it's unambiguous: exactly one unlinked hand-recorded
-- payment on a proposal whose Xero invoice is for the same amount. Anything
-- with two payments, a part payment or a mismatched total is left alone for a
-- person to look at — a wrong link here silently hides real money.
WITH candidate AS (
  SELECT mp.id AS payment_id, pb.xero_invoice_id
    FROM manual_payments mp
    JOIN proposal_billing pb ON pb.proposal_id = mp.proposal_id
   WHERE mp.manual_invoice_id IS NULL
     AND mp.xero_invoice_id IS NULL
     AND pb.xero_invoice_id IS NOT NULL
     AND pb.invoice_amount IS NOT NULL
     AND ABS(mp.amount - pb.invoice_amount) < 0.01
     AND (SELECT COUNT(*) FROM manual_payments m2
           WHERE m2.proposal_id = mp.proposal_id
             AND m2.manual_invoice_id IS NULL) = 1
)
UPDATE manual_payments mp
   SET xero_invoice_id = c.xero_invoice_id
  FROM candidate c
 WHERE mp.id = c.payment_id;
