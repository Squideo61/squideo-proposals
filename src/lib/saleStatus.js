// Where a signed deal has got to on the way to being paid, as display pills.
//
// One vocabulary shared by the pipeline rows and the deal page's proposal card,
// so the same deal can't read "Invoiced" in one place and something else in the
// other. Fed by `deal.saleStatus`, computed server-side in annotateDeals().
//
// The ladder after signature:
//   Pending PO      — PO-route deal, client hasn't raised the PO yet
//   PO <number>     — PO received (any deal can have one uploaded, not just
//                     PO-route ones, in which case it sits alongside the
//                     payment state rather than replacing it)
//   Pending invoice — signed, nothing raised yet: the ball is with us
//   Pending payment — invoiced and waiting on the client
//   Deposit paid    — 50/50 with the deposit in and the balance outstanding
//   Paid            — settled in full

const SIGNED_STAGES = new Set(['signed', 'paid']);

export function describeSaleStatus(deal) {
  const s = deal?.saleStatus;
  if (!s || !SIGNED_STAGES.has(deal?.stage)) return [];

  // A PO-route deal still awaiting its PO says only that — adding "pending
  // invoice" alongside would be noise, since we can't invoice without the PO.
  if (s.isPo && !s.poReceivedAt) return [{ key: 'pending-po', label: 'Pending PO', tone: 'amber' }];

  const pills = [];
  if (s.poReceivedAt) pills.push({ key: 'po', label: `PO ${s.poNumber || ''}`.trim(), tone: 'green' });

  if (s.paidInFull)        pills.push({ key: 'paid',            label: 'Paid',            tone: 'green' });
  else if (s.depositPaid)  pills.push({ key: 'deposit-paid',    label: 'Deposit paid',    tone: 'teal' });
  else if (s.invoiced)     pills.push({ key: 'pending-payment', label: 'Pending payment', tone: 'amber' });
  else                     pills.push({ key: 'pending-invoice', label: 'Pending invoice', tone: 'grey' });

  return pills;
}
