// Portal "Add extras" offer derivation + pricing authority.
//
// Same doctrine as api/_lib/proposalPricing.js: every PRICE comes from
// staff-controlled data (the proposal's optionalExtras — already tailored to
// this client's video length — or a staff-priced portal_extra_offers row);
// the client only ever sends an offer KEY. The server recomputes the price on
// accept, so a tampered amount can never reach deal_extras.
//
// Offer keys:
//   prop:<extraId>[:qty] — a proposal-derived extra (10% portal discount, or
//                          the deal's portal_extras_discount override)
//   custom:<pxoId>       — a staff-added upsell (amount IS the final price)

import sql from '../db.js';
import { ensurePortalTables } from './db.js';

const VARIANT_ELIGIBLE_IDS = new Set(['translatedsubs', 'fulltranslate']);

// Mirror of extraHasVariants in src/defaults.js / api/_lib/proposalPricing.js.
function extraHasVariants(extra) {
  if (!extra) return false;
  if (!VARIANT_ELIGIBLE_IDS.has(extra.id)) return false;
  if (typeof extra.variantsEnabled === 'boolean') return extra.variantsEnabled;
  return true;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Load the signed proposal + signature for a deal (latest proposal wins; the
// deterministic auto-deal id `deal_<proposalId>` is also handled by deal_id).
export async function loadDealProposalState(dealId) {
  const rows = await sql`
    SELECT p.id, p.data, s.data AS signature_data, s.signed_at
      FROM proposals p
      LEFT JOIN signatures s ON s.proposal_id = p.id
     WHERE p.deal_id = ${dealId}
     ORDER BY (s.signed_at IS NOT NULL) DESC, p.created_at DESC NULLS LAST
     LIMIT 1
  `;
  return rows[0] || null;
}

// Compute the live offer list for a deal. Returns [] when the deal has no
// signed proposal (nothing to derive prices from) and no custom offers.
export async function computePortalOffers(deal) {
  await ensurePortalTables();
  const state = await loadDealProposalState(deal.id);
  const proposalData = state?.data || null;
  const signatureData = state?.signature_data || null;

  const discount = Math.min(Math.max(Number(deal.portal_extras_discount ?? 0.10) || 0, 0), 1);

  // Extras already bought at signing can't be offered again (except
  // quantity-based variant extras, which can always take more units).
  const boughtIds = new Set(
    (Array.isArray(signatureData?.selectedExtras) ? signatureData.selectedExtras : [])
      .map((e) => e?.id)
      .filter(Boolean)
  );

  const offersRows = await sql`
    SELECT id, kind, proposal_extra_id, title, description, amount, hidden
      FROM portal_extra_offers WHERE deal_id = ${deal.id}
     ORDER BY created_at ASC
  `;
  const overridesById = new Map(
    offersRows.filter((r) => r.kind === 'override' && r.proposal_extra_id)
      .map((r) => [r.proposal_extra_id, r])
  );

  const out = [];

  // Proposal-derived offers — only extras the client actually saw in their
  // proposal, priced from there (length-dependence inherited), minus discount.
  const proposalExtras = Array.isArray(proposalData?.optionalExtras) ? proposalData.optionalExtras : [];
  for (const e of proposalExtras) {
    if (!e || !e.id) continue;
    const hasVariants = extraHasVariants(e);
    if (boughtIds.has(e.id) && !hasVariants) continue;
    const override = overridesById.get(String(e.id)) || null;
    if (override?.hidden) continue;
    const listPrice = Number(e.price) || 0;
    if (listPrice <= 0) continue;
    const priced = override?.amount != null ? Number(override.amount) : round2(listPrice * (1 - discount));
    out.push({
      key: `prop:${e.id}`,
      kind: 'proposal',
      title: e.label || e.name || e.title || 'Extra',
      description: e.description || e.desc || null,
      originalAmount: round2(listPrice),
      amount: round2(priced),
      hasQuantity: hasVariants,
      alreadyPurchased: boughtIds.has(e.id),
    });
  }

  // Staff custom upsells — amount is the final price; no further discount.
  for (const r of offersRows) {
    if (r.kind !== 'custom' || r.hidden) continue;
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.push({
      key: `custom:${r.id}`,
      kind: 'custom',
      title: r.title || 'Extra',
      description: r.description || null,
      originalAmount: null,
      amount: round2(amount),
      hasQuantity: false,
      alreadyPurchased: false,
    });
  }

  return out;
}

// Authoritative pricing for an accept: resolve an offer key back to a priced
// offer, recomputing from the proposal/offer rows. Returns null for anything
// that isn't currently offerable (hidden, bought, unknown, non-positive).
export async function resolveOfferForAccept(deal, offerKey, quantity = 1) {
  const key = String(offerKey || '');
  const qty = Math.max(1, Math.min(50, Math.floor(Number(quantity) || 1)));
  const offers = await computePortalOffers(deal);

  if (key.startsWith('prop:')) {
    const offer = offers.find((o) => o.key === key && o.kind === 'proposal');
    if (!offer) return null;
    const useQty = offer.hasQuantity ? qty : 1;
    return {
      title: offer.title,
      quantity: useQty,
      unitAmount: offer.amount,
      amount: round2(offer.amount * useQty),
      originalAmount: offer.originalAmount != null ? round2(offer.originalAmount * useQty) : null,
      discounted: offer.originalAmount != null && offer.amount < offer.originalAmount,
    };
  }
  if (key.startsWith('custom:')) {
    const offer = offers.find((o) => o.key === key && o.kind === 'custom');
    if (!offer) return null;
    return {
      title: offer.title,
      quantity: 1,
      unitAmount: offer.amount,
      amount: offer.amount,
      originalAmount: null,
      discounted: false,
    };
  }
  return null;
}

// Extras may be added while the deal is live: signed/paid and not yet in
// after-care. (Staff can still log extras from the CRM at any time.)
export function extrasWindowOpen(deal) {
  const stage = deal?.stage || null;
  if (stage !== 'signed' && stage !== 'paid') return false;
  return deal?.production_phase !== 'after_care';
}
