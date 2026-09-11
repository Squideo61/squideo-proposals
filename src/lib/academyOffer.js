// A Squideo Academy offered on a proposal, and the words the client reads for
// it on the proposal page, the PDF and the builder's preview. Pure.
//
// The plan is stored on the proposal as it was when the proposal was written:
// a signed proposal is a contract, so a later price change on the academy
// platform must not rewrite what the client agreed to. Plan prices come from
// the platform in PENCE and stay in pence on the proposal; the set-up fee is
// typed in POUNDS, like every other price on a proposal. Everything leaving
// academyOffer() is in pounds.
//
// The academy is invoiced separately from the project, by the CRM, so none of
// this is ever part of a proposal's total or its payment options.

// The platform's rule: nobody is locked out, and the first tenth over the
// allowance in a month is free (squideo-lms api/_lib/plans.js freeOver).
export const FREE_OVER_SHARE = 0.1;

const pounds = (pence) => Math.round(Number(pence) || 0) / 100;

/** The offer in pounds, or null when the proposal has none. */
export function academyOffer(data) {
  const a = data?.academy;
  const plan = a?.enabled ? a.plan : null;
  if (!plan?.slug || !(Number(plan.monthly) > 0)) return null;
  const annual = a.billingPeriod === 'annual';
  const learners = Number(plan.learners) > 0 ? Number(plan.learners) : null;
  const setupFee = Math.round((Number(a.setupFee) || 0) * 100) / 100;
  const yearOfMonths = Number(plan.annual) > 0 ? Number(plan.annual) / Number(plan.monthly) : 12;
  return {
    slug: plan.slug,
    name: plan.name || plan.slug,
    learners,
    annual,
    price: pounds(annual ? plan.annual : plan.monthly),
    monthly: pounds(plan.monthly),
    freeMonths: annual ? Math.max(0, Math.round(12 - yearOfMonths)) : 0,
    extra: Number(plan.extra) > 0 ? pounds(plan.extra) : null,
    freeOver: learners ? Math.floor(learners * FREE_OVER_SHARE) : 0,
    setupFee: setupFee > 0 ? setupFee : 0,
    description: String(a.description || '').trim(),
  };
}

export const DEFAULT_ACADEMY_DESCRIPTION = 'Your own branded learning academy. Your videos become courses your '
  + 'people can take on any device, with quizzes, sign-off and progress you can see.';

// £149, £1,490, £99.50.
export function money(n) {
  const v = Number(n) || 0;
  return '£' + v.toLocaleString('en-GB', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
}

// 75p, £1.30.
export const perHead = (n) => (n < 1 ? `${Math.round(n * 100)}p` : money(n));

/** "Up to 200 active learners a month". */
export function allowanceText(o) {
  return o.learners ? `Up to ${o.learners.toLocaleString('en-GB')} active learners a month` : 'Learners as agreed';
}

/** "£149 a month" / "£1,490 a year". */
export function priceText(o) {
  return `${money(o.price)} a ${o.annual ? 'year' : 'month'}`;
}

/**
 * The terms, as short sentences: how it is billed, what a busy month costs,
 * and that it sits outside the project total. `vat` adds "+ VAT" to the
 * per-person price, as the page does to every other price.
 */
export function termsText(o, { vat = true } = {}) {
  const plusVat = vat ? ' + VAT' : '';
  const lines = [
    o.annual
      ? `Billed yearly in advance${o.freeMonths > 0 ? `, which works out at ${o.freeMonths === 1 ? 'a month' : `${o.freeMonths} months`} free` : ''}.`
      : 'Billed monthly. Cancel any time: there is no minimum term.',
  ];
  if (o.extra && o.learners) {
    lines.push(`Nobody is locked out in a busy month. If more than ${o.learners.toLocaleString('en-GB')} people learn, `
      + `the first ${o.freeOver} extra are free and each one after that is ${perHead(o.extra)}${plusVat}, `
      + `invoiced once the ${o.annual ? 'quarter' : 'month'} ends.`);
  }
  lines.push('Invoiced separately from the project: it is not part of the project price.');
  return lines;
}

// What goes into a proposal's builder hint and the mobile section nav.
export function offerHint(data) {
  const o = academyOffer(data);
  if (!o) return data?.academy?.enabled ? 'Choose a plan' : 'Off';
  return `${o.name}, ${priceText(o)}`;
}
