// Authoritative server-side recompute of what a client owes for a signed
// proposal. Every PRICE comes from the proposal's `data` (staff-controlled);
// only the SELECTIONS (which video option, which extras + quantities, partner
// credits, payment option) come from the signature. This mirrors the client
// pricing in src/components/ClientView.jsx so the figure matches what the
// client saw — while never trusting any client-supplied amount/total. Used by
// the Stripe checkout route to reject tampered (under-payment) amounts.

const VARIANT_ELIGIBLE_IDS = new Set(['translatedsubs', 'fulltranslate']);

// Mirror of extraHasVariants in src/defaults.js.
function extraHasVariants(extra) {
  if (!extra) return false;
  if (!VARIANT_ELIGIBLE_IDS.has(extra.id)) return false;
  if (typeof extra.variantsEnabled === 'boolean') return extra.variantsEnabled;
  return true;
}

// Mirror of computeBaseDiscount in src/utils.js.
function computeBaseDiscount(basePrice, discount) {
  const v = Number(discount?.value) || 0;
  if (v <= 0) return 0;
  const base = Number(basePrice) || 0;
  if (discount?.type === 'amount') return Math.min(v, base);
  return base * Math.min(v, 100) / 100;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Recompute the gross amount due *now* for a signed proposal, plus the partner
// ex-VAT split the checkout uses for its two line items. Returns null if there
// isn't enough data to price (caller should refuse the checkout).
//
//   proposalData  — proposals.data JSONB (prices, vatRate, discount, partner cfg)
//   signatureData — signatures.data JSONB (the client's selections only)
export function computeProposalCheckout(proposalData, signatureData) {
  if (!proposalData) return null;
  const data = proposalData;
  const sig = signatureData || {};
  const vatRate = Number(data.vatRate) || 0;

  // --- Base / selected video-option price (matched back to the proposal) ---
  const proposalVideoOptions = Array.isArray(data.videoOptions) && data.videoOptions.length
    ? data.videoOptions : null;
  let effectiveBasePrice = Number(data.basePrice) || 0;
  let selectedOption = null;
  if (proposalVideoOptions) {
    const sel = sig.selectedVideoOption || null;
    let opt = null;
    if (sel) {
      opt = proposalVideoOptions.find(v =>
        (v.id && sel.id && v.id === sel.id)
        || (v.label && sel.label && v.label === sel.label)
      ) || null;
    }
    // No match → the client's default selection is the first option.
    selectedOption = opt || proposalVideoOptions[0] || null;
    effectiveBasePrice = Number(selectedOption?.price) || effectiveBasePrice;
  }

  // --- Selected extras (prices from the proposal, matched by id) ---
  const proposalExtras = Array.isArray(data.optionalExtras) ? data.optionalExtras : [];
  const extrasById = new Map(proposalExtras.map(e => [e.id, e]));
  const selectedExtras = Array.isArray(sig.selectedExtras) ? sig.selectedExtras : [];
  let extrasTotal = 0;
  for (const selRaw of selectedExtras) {
    const e = extrasById.get(selRaw?.id);
    if (!e) continue; // a selection not present in the proposal can't be charged
    const qty = extraHasVariants(e) ? Math.max(1, Number(selRaw.quantity) || 1) : 1;
    extrasTotal += (Number(e.price) || 0) * qty;
  }

  const partnerSelected = sig.partnerSelected === true;
  const partnerCredits = Math.max(1, Number(sig.partnerCredits) || 1);

  // --- Standard (non-partner) totals ---
  // A project that's already free (base £0 or 100% manual discount) stays free on
  // the Partner Programme — keep its discount instead of dropping it for a smaller
  // partner %. Mirrors ClientView so the validated total matches what the client saw.
  const manualDiscountAmount = computeBaseDiscount(effectiveBasePrice, data.discount);
  const projectFullyDiscounted = effectiveBasePrice <= 0 || manualDiscountAmount >= effectiveBasePrice - 0.005;
  const manualDiscount = (partnerSelected && !projectFullyDiscounted) ? 0 : manualDiscountAmount;
  const netBasePrice = effectiveBasePrice - manualDiscount;
  const subtotal = netBasePrice + extrasTotal;        // ex VAT
  const total = subtotal * (1 + vatRate);             // gross

  // --- Partner-programme ladder (all rates from the proposal) ---
  const pp = data.partnerProgramme || {};
  const partnerBaseDiscount   = pp.discountRate ?? 0.10;
  const partnerExtraPerCredit = pp.extraDiscountPerCredit ?? 0;
  const partnerMaxDiscount    = pp.maxDiscount ?? partnerBaseDiscount;
  const effectiveDiscount = Math.min(
    partnerBaseDiscount + Math.max(0, partnerCredits - 1) * partnerExtraPerCredit,
    partnerMaxDiscount
  );
  const standardRatePerMin = Number(pp.standardRatePerMin) || Number(data.basePrice) || 0;
  const partnerRatePerMin  = standardRatePerMin * (1 - effectiveDiscount);
  const partnerSubtotal     = partnerRatePerMin * partnerCredits;   // ex VAT (recurring)
  const partnerTotal        = partnerSubtotal * (1 + vatRate);      // gross
  // Credit-only proposals quote the deliverable in minutes at the standard rate
  // and discount ONLY the extra minutes added on the proposal, so the project
  // subtotal never gets a partner discount here. Mirrors ClientView.
  const isCreditOnly = pp.mode === 'oneoff' && !!pp.creditOnly;
  const partnerDiscount     = (projectFullyDiscounted || isCreditOnly) ? 0 : subtotal * effectiveDiscount;
  const discountedSubtotal  = subtotal - partnerDiscount;          // project ex VAT
  const discountedTotal     = discountedSubtotal * (1 + vatRate);  // gross

  // One-off Content Credit is a single upfront purchase (not a recurring
  // subscription), so — unlike the subscription programme — it can use the
  // 50/50 split and is billed once. `partnerTotal` here is that one-time block.
  const isOneoff = pp.mode === 'oneoff';
  const paymentOption = sig.paymentOption || 'full';
  const isDeposit = paymentOption === '5050' && (isOneoff || !partnerSelected);

  // Gross amount collected *now*. Mirrors ClientView.dueNowTotal + the deposit
  // split. Subscription partner always pays the full discounted project + first
  // month; one-off partner can split the combined project + credit 50/50.
  let amountGross;
  if (partnerSelected) {
    const combined = discountedTotal + partnerTotal;
    amountGross = (isOneoff && isDeposit) ? combined / 2 : combined;
  } else {
    amountGross = isDeposit ? total / 2 : total;
  }

  // Minutes quoted in the main section — in credit-only mode these are content
  // credit too, so downstream can bank base + added together.
  const baseCreditMinutes = isCreditOnly
    ? (Number(selectedOption?.minutes) || Number(pp.quotedMinutes) || 0)
    : 0;

  return {
    vatRate,
    isDeposit,
    partnerSelected,
    partnerCredits,
    creditOnly: isCreditOnly,
    baseCreditMinutes,
    amountGross: round2(amountGross),
    projectExVat: round2(discountedSubtotal),
    partnerExVat: round2(partnerSubtotal),
  };
}
