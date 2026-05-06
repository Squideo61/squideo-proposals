// Pure mappers from Squideo proposal/signature shapes to Xero line items.
// VAT defaults to UK 20% via TaxType OUTPUT2; AccountCode 200 is Xero's
// standard "Sales" account in the default UK chart of accounts.

const SALES_ACCOUNT = '200';
const TAX_OUTPUT_20 = 'OUTPUT2';
const TAX_NONE = 'NONE';

function taxTypeForRate(rate) {
  return Number(rate) > 0 ? TAX_OUTPUT_20 : TAX_NONE;
}

export function lineItemsForProject(proposal, signed) {
  const taxType = taxTypeForRate(proposal.vatRate);
  const lines = [{
    description: proposal.proposalTitle || proposal.clientName || 'Video production',
    quantity: 1,
    unitAmount: Number(proposal.basePrice) || 0,
    taxType,
    accountCode: SALES_ACCOUNT,
  }];

  const chosen = Array.isArray(signed?.selectedExtras) ? signed.selectedExtras : [];
  for (const extra of chosen) {
    lines.push({
      description: extra.label || extra.id,
      quantity: 1,
      unitAmount: Number(extra.price) || 0,
      taxType,
      accountCode: SALES_ACCOUNT,
    });
  }
  return lines;
}

// 50% deposit collapses the project to a single line so the balance invoice
// later is a clean mirror — easier to reconcile in Xero than splitting every
// extra in half.
export function depositLineItems(proposal, signed, fraction = 0.5) {
  const taxType = taxTypeForRate(proposal.vatRate);
  const projectLines = lineItemsForProject(proposal, signed);
  const subtotal = projectLines.reduce((s, l) => s + l.unitAmount, 0);
  const title = proposal.proposalTitle || proposal.clientName || 'Video production';
  const pct = Math.round(fraction * 100);
  return [{
    description: `${title} — ${pct}% deposit`,
    quantity: 1,
    unitAmount: Number((subtotal * fraction).toFixed(2)),
    taxType,
    accountCode: SALES_ACCOUNT,
  }];
}

// Discounted project lines for the Partner Programme path: applies the
// effectiveDiscount captured in signed.amountBreakdown.discountRate to every
// project line so each one shows the discounted unit price.
export function lineItemsForDiscountedProject(proposal, signed) {
  const taxType = taxTypeForRate(proposal.vatRate);
  const discount = Number(signed?.amountBreakdown?.discountRate) || 0;
  const factor = 1 - discount;
  const base = lineItemsForProject(proposal, signed);
  return base.map(l => ({
    ...l,
    description: discount > 0 ? `${l.description} (Partner discount ${(discount * 100).toFixed(1)}%)` : l.description,
    unitAmount: Number((l.unitAmount * factor).toFixed(2)),
    taxType,
  }));
}

export function lineItemsForPartnerFirstMonth(proposal, signed) {
  const taxType = taxTypeForRate(proposal.vatRate);
  const credits = Number(signed?.partnerCredits) || 1;
  const partnerExVat = Number(signed?.amountBreakdown?.partnerExVat) || 0;
  const ratePerCredit = credits > 0 ? partnerExVat / credits : partnerExVat;
  return [{
    description: `Squideo Partner Programme — first month (${credits} min credit${credits === 1 ? '' : 's'})`,
    quantity: credits,
    unitAmount: Number(ratePerCredit.toFixed(2)),
    taxType,
    accountCode: SALES_ACCOUNT,
  }];
}

export function lineItemsForPartnerMonthly(proposal, signed, monthNumber) {
  const taxType = taxTypeForRate(proposal.vatRate);
  const credits = Number(signed?.partnerCredits) || 1;
  const partnerExVat = Number(signed?.amountBreakdown?.partnerExVat) || 0;
  const ratePerCredit = credits > 0 ? partnerExVat / credits : partnerExVat;
  const monthLabel = monthNumber ? ` — month ${monthNumber}` : '';
  return [{
    description: `Squideo Partner Programme${monthLabel} (${credits} min credit${credits === 1 ? '' : 's'})`,
    quantity: credits,
    unitAmount: Number(ratePerCredit.toFixed(2)),
    taxType,
    accountCode: SALES_ACCOUNT,
  }];
}
