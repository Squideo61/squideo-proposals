// Which hand-recorded payments count towards a deal — defined once.
//
// When a client pays a Xero invoice by BACS the bank tells nobody, so the team
// records it in the CRM the same day. That has to keep working: the CRM cannot
// see the bank, and waiting for Xero to reconcile would mean a deal reading
// "unpaid" for days after the money landed.
//
// The problem was what happened next. Xero reconciles, we stamp
// proposal_billing.paid_amount from it, and now two rows describe the same
// £2,000 — with every "how much has this deal paid" query adding them together.
// manual_payments already had this guard for MANUAL invoices (manual_invoice_id
// IS NULL); there was simply no equivalent for the Xero invoices we raise off a
// proposal.
//
// So a hand-recorded payment can now name the invoice it settles, and the rule
// lives in a VIEW rather than in the dozen places that read it — the deal page,
// the pipeline pills, company balances, Finance, commission. Twelve copies of a
// money rule is twelve chances for the deal page and Finance to disagree, and
// the first you'd know is a figure that looks wrong and can't be traced.
//
// THE RULE: a linked payment keeps counting until Xero confirms the invoice.
// Excluding it the moment it's linked would defeat the point of recording it —
// the deal would read £0 paid until Xero caught up, which is worse than the
// double count. Once paid_amount lands, Xero's figure takes over.
//
// Mirrors db/migrations/20260821_manual_payment_invoice_link.sql.

import sql from '../db.js';

let ensured = null;
export function ensureManualPaymentLink() {
  if (ensured) return ensured;
  ensured = (async () => {
    try {
      await sql`ALTER TABLE manual_payments ADD COLUMN IF NOT EXISTS xero_invoice_id TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS manual_payments_xero_invoice_idx
                  ON manual_payments (xero_invoice_id) WHERE xero_invoice_id IS NOT NULL`;
      await sql`
        CREATE OR REPLACE VIEW manual_payments_counted AS
          SELECT mp.*
            FROM manual_payments mp
            LEFT JOIN proposal_billing pb ON pb.xero_invoice_id = mp.xero_invoice_id
           WHERE mp.manual_invoice_id IS NULL
             AND (mp.xero_invoice_id IS NULL OR COALESCE(pb.paid_amount, 0) <= 0)`;
    } catch (err) {
      console.warn('[manualPaymentLink] ensure failed', err.message);
    }
  })();
  return ensured;
}

// The Xero invoices raised for a proposal that nothing has been paid against
// yet — what the "record a payment" form offers to link to, so the person
// entering a BACS payment can say which invoice it settles without having to
// know it matters.
export async function outstandingProposalInvoices(proposalId) {
  if (!proposalId) return [];
  await ensureManualPaymentLink();
  const rows = await sql`
    SELECT pb.xero_invoice_id, pb.invoice_amount, pb.paid_amount,
           pb.billing->>'invoiceNumber' AS invoice_number
      FROM proposal_billing pb
     WHERE pb.proposal_id = ${proposalId}
       AND pb.xero_invoice_id IS NOT NULL
       AND COALESCE(pb.paid_amount, 0) <= 0
  `.catch(() => []);
  return rows.map((r) => ({
    xeroInvoiceId: r.xero_invoice_id,
    invoiceNumber: r.invoice_number || null,
    amount: r.invoice_amount == null ? null : Number(r.invoice_amount),
  }));
}
