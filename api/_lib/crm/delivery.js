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

// Final delivery: once a signed-off video's final invoice is settled (or the
// staff override is set), it's delivered — advance it to the Completed phase so
// the client's phase bar moves off "In production". Best-effort self-heal called
// wherever we already know a video is at a gated stage; safe to call repeatedly.
// Returns the number of videos advanced. Pass a precomputed `unlocked` to avoid
// recomputing the balance when the caller already has it.
export async function advanceDeliveredIfUnlocked(dealId, unlocked = null) {
  if (!dealId) return 0;
  try {
    // Only do the (relatively costly) unlock check when there's actually a video
    // parked at a gated stage waiting to be delivered.
    const [{ n }] = await sql`
      SELECT COUNT(*)::int AS n FROM project_videos
       WHERE deal_id = ${dealId} AND production_stage IN ('signed_off', 'final_invoice')`;
    if (!n) return 0;
    const isUnlocked = unlocked == null ? await isFinalReleaseUnlocked(dealId) : unlocked;
    if (!isUnlocked) return 0;
    const rows = await sql`
      UPDATE project_videos
         SET production_phase = 'completed', production_stage = 'delivered',
             production_stage_changed_at = NOW(), updated_at = NOW()
       WHERE deal_id = ${dealId} AND production_stage IN ('signed_off', 'final_invoice')
       RETURNING id`;
    return rows.length;
  } catch (err) {
    console.warn('[delivery] advanceDeliveredIfUnlocked failed', dealId, err.message);
    return 0;
  }
}
