// Pure Video Credit pricing — the Content Credit one-off ladder, with NO DB or
// side-effect imports so it's trivially unit-testable and safe to mirror on the
// client. The DB-backed helpers (balance, ledger writes, rate lookup) live in
// videoCredit.js, which re-exports these.
//
// Ladder: a per-minute rate discounted more the more minutes you buy — 15% base,
// +3% per extra minute, capped at 30% (matches makeContentCreditTemplate in
// src/defaults.js). This is the SERVER-SIDE authority for the Stripe amount.

export const VIDEO_CREDIT = {
  baseDiscount: 0.15,
  stepPerMin: 0.03,
  maxDiscount: 0.30,
  vatRate: 0.20,
  defaultRatePerMin: 1250, // £/min — matches the Content Credit default
};

// Effective discount fraction for buying `minutes` minutes (climbs with volume).
export function videoCreditDiscount(minutes) {
  const m = Math.max(1, Math.floor(Number(minutes) || 0));
  return Math.min(VIDEO_CREDIT.baseDiscount + (m - 1) * VIDEO_CREDIT.stepPerMin, VIDEO_CREDIT.maxDiscount);
}

// The authoritative quote for buying `minutes` at `ratePerMin`. All money is a
// plain number of pounds; the caller converts to pence for Stripe.
export function videoCreditQuote(minutes, ratePerMin) {
  const m = Math.max(1, Math.floor(Number(minutes) || 0));
  const rate = Number(ratePerMin) || VIDEO_CREDIT.defaultRatePerMin;
  const discount = videoCreditDiscount(m);
  const unitExVat = rate * (1 - discount);
  const subtotalExVat = unitExVat * m;
  const vat = subtotalExVat * VIDEO_CREDIT.vatRate;
  return {
    minutes: m,
    ratePerMin: rate,
    discount,
    unitExVat,
    subtotalExVat,
    vat,
    totalIncVat: subtotalExVat + vat,
  };
}
