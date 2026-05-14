// Pure mappers from Squideo proposal/signature shapes to Xero line items.
// VAT defaults to UK 20% via TaxType OUTPUT2; AccountCode 200 is Xero's
// standard "Sales" account in the default UK chart of accounts.

const SALES_ACCOUNT = '200';
const TAX_OUTPUT_20 = 'OUTPUT2';
const TAX_NONE = 'NONE';

function taxTypeForRate(rate) {
  return Number(rate) > 0 ? TAX_OUTPUT_20 : TAX_NONE;
}

// Format proposal number columns into a stable display string. Returns null
// when either side is missing so callers can fall back to the title.
export function formatProposalNumber(year, seq) {
  if (!year || !seq) return null;
  return `Squideo ${year}-${String(seq).padStart(3, '0')}`;
}

export function lineItemsForProject(proposal, signed, proposalNumber) {
  const taxType = taxTypeForRate(proposal.vatRate);
  // Prefer the actual deliverable text the client agreed to: in option mode
  // that's the picked option's description; in single mode it's the
  // proposal's requirement field. Fall back to title for legacy proposals
  // with neither field populated.
  const requirementText =
    signed?.selectedVideoOption?.description?.trim()
    || proposal.requirement?.trim()
    || proposal.proposalTitle
    || proposal.clientName
    || 'Video production';
  const prefix = proposalNumber ? `${proposalNumber} — ` : '';
  const lines = [{
    description: prefix + requirementText,
    quantity: 1,
    unitAmount: Number(signed?.selectedVideoOption?.price ?? proposal.basePrice) || 0,
    taxType,
    accountCode: SALES_ACCOUNT,
  }];

  const chosen = Array.isArray(signed?.selectedExtras) ? signed.selectedExtras : [];
  for (const extra of chosen) {
    const baseDesc = extra.label || extra.id;
    const description = extra.languages ? `${baseDesc} — ${extra.languages}` : baseDesc;
    lines.push({
      description,
      quantity: Math.max(1, Number(extra.quantity) || 1),
      unitAmount: Number(extra.price) || 0,
      taxType,
      accountCode: SALES_ACCOUNT,
    });
  }
  return lines;
}

// 50% deposit invoice — itemise base + extras, each at the deposit fraction
// so the eventual balance invoice can mirror the same line breakdown.
export function depositLineItems(proposal, signed, fraction = 0.5, proposalNumber) {
  const projectLines = lineItemsForProject(proposal, signed, proposalNumber);
  const pct = Math.round(fraction * 100);
  return projectLines.map(l => ({
    ...l,
    description: `${l.description} (${pct}% deposit)`,
    unitAmount: Number((l.unitAmount * fraction).toFixed(2)),
  }));
}

// Discounted project lines for the Partner Programme path: applies the
// effectiveDiscount captured in signed.amountBreakdown.discountRate to every
// project line so each one shows the discounted unit price.
export function lineItemsForDiscountedProject(proposal, signed, proposalNumber) {
  const taxType = taxTypeForRate(proposal.vatRate);
  const discount = Number(signed?.amountBreakdown?.discountRate) || 0;
  const factor = 1 - discount;
  const base = lineItemsForProject(proposal, signed, proposalNumber);
  return base.map(l => ({
    ...l,
    description: discount > 0 ? `${l.description} (Partner discount ${(discount * 100).toFixed(1)}%)` : l.description,
    unitAmount: Number((l.unitAmount * factor).toFixed(2)),
    taxType,
  }));
}

export function lineItemsForPartnerFirstMonth(proposal, signed, proposalNumber) {
  const taxType = taxTypeForRate(proposal.vatRate);
  const credits = Number(signed?.partnerCredits) || 1;
  const partnerExVat = Number(signed?.amountBreakdown?.partnerExVat) || 0;
  const ratePerCredit = credits > 0 ? partnerExVat / credits : partnerExVat;
  const prefix = proposalNumber ? `${proposalNumber} — ` : '';
  return [{
    description: `${prefix}Squideo Partner Programme — first month (${credits} min credit${credits === 1 ? '' : 's'})`,
    quantity: credits,
    unitAmount: Number(ratePerCredit.toFixed(2)),
    taxType,
    accountCode: SALES_ACCOUNT,
  }];
}

export function lineItemsForPartnerMonthly(proposal, signed, monthNumber, proposalNumber) {
  const taxType = taxTypeForRate(proposal.vatRate);
  const credits = Number(signed?.partnerCredits) || 1;
  const partnerExVat = Number(signed?.amountBreakdown?.partnerExVat) || 0;
  const ratePerCredit = credits > 0 ? partnerExVat / credits : partnerExVat;
  const prefix = proposalNumber ? `${proposalNumber} — ` : '';
  const monthLabel = monthNumber ? ` — month ${monthNumber}` : '';
  return [{
    description: `${prefix}Squideo Partner Programme${monthLabel} (${credits} min credit${credits === 1 ? '' : 's'})`,
    quantity: credits,
    unitAmount: Number(ratePerCredit.toFixed(2)),
    taxType,
    accountCode: SALES_ACCOUNT,
  }];
}
