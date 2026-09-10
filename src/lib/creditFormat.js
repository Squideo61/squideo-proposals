// Credit minutes, as a person should read them: one decimal place.
//
// Shared by the CRM and the client portal so a balance reads identically on
// both sides — the CRM's credit cards are deliberately "the same numbers, in the
// same words" as the portal, and that promise breaks the moment the two round
// differently.
//
// Balances are sums of ledger rows, and float addition leaves tails like
// 2.3000000000000007 that must never reach a screen. Rounded on the absolute
// value so a negative adjustment rounds the same way as its positive, and a
// result of zero prints "0" rather than "-0".
export function formatCreditMinutes(n) {
  const v = Number(n) || 0;
  const r = Math.round((Math.abs(v) + Number.EPSILON) * 10) / 10;
  if (r === 0) return '0';
  const s = Number.isInteger(r) ? String(r) : r.toFixed(1);
  return v < 0 ? '-' + s : s;
}
