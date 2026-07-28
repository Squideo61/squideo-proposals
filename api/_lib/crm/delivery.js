// Whether a deal's final video may be released to the client. The rule: the
// deal must be paid in full (no outstanding balance) OR a staff member has set
// the release override. Used to gate the portal's downloadable signed-off cut.

import sql from '../db.js';
import { reconcileProposalBillingPaid } from './invoices.js';
import { computeCompanyDealBalances } from './companies.js';

// The deal's current outstanding balance (inc-VAT), reconciling proposal_billing
// against Xero first so a just-paid final invoice is reflected. Returns a number
// (0 when clear) or null if the deal is missing.
export async function dealOutstanding(dealId) {
  const [d] = await sql`SELECT company_id FROM deals WHERE id = ${dealId}`;
  if (!d || !d.company_id) return null;
  try {
    const props = (await sql`SELECT id FROM proposals WHERE deal_id = ${dealId}`).map((r) => r.id);
    if (props.length) await reconcileProposalBillingPaid(props);
  } catch { /* freshness is best-effort */ }
  const balances = await computeCompanyDealBalances(d.company_id);
  return balances[dealId]?.outstanding ?? 0;
}

// Whether the deal's final video may be released: paid in full OR staff override.
export async function isFinalReleaseUnlocked(dealId) {
  if (!dealId) return false;
  const [d] = await sql`SELECT final_release_override_at FROM deals WHERE id = ${dealId}`;
  if (!d) return false;
  if (d.final_release_override_at) return true;
  const outstanding = await dealOutstanding(dealId);
  return (outstanding ?? 0) <= 0;
}
