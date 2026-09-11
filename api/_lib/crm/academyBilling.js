// Academy billing, as the CRM sees it. Pure: no database, no network.
//
// The academy platform (squideo-lms) works out what an academy is entitled to:
// its plan, trial, usage and the statement for extra people. The CRM owns the
// money, so this module answers the CRM's questions about each academy it is
// handed by the platform's private API:
//
//   - what is due to invoice now: the plan fee for the current plan period, and
//     the extra-people statement for the last complete billing period;
//   - what needs somebody's attention: a trial ending, a plan asked for, an
//     academy outgrowing its plan or barely used, an annual renewal coming up;
//   - the totals at the top of the Academies page.
//
// Money arrives in PENCE from the platform and leaves here in POUNDS, which is
// what every CRM money column holds. Card amounts stay in pence, as Stripe's do.

export const LOW_USAGE_SHARE = 0.2;      // three-month average at or under 20% of the allowance
export const ALERT_WINDOW_DAYS = 30;     // a trial ending or an annual renewal this soon
export const VAT_RATE = 0.2;
const DAY = 86_400_000;

export const pounds = (pence) => Math.round(Number(pence) || 0) / 100;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const isoDay = (d) => d.toISOString().slice(0, 10);
const monthKey = (d) => d.toISOString().slice(0, 7);
const quarterKey = (d) => `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;

// "20 Oct 2026". UTC, because plan dates are UTC timestamps and a period that
// starts at midnight must not print as the day before.
export function fmtDay(v) {
  const d = toDate(v);
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
}

/**
 * Is this academy on a plan that gets invoiced: a priced plan, outside a trial,
 * and not a demo. Free, a quoted deal and a legacy arrangement are not billed
 * from here.
 */
export function isBilled(academy) {
  const s = academy?.summary;
  return Boolean(s && !academy.demo && s.trial?.phase === 'none'
    && s.plan && !s.plan.quoted && Number(s.plan.monthly) > 0);
}

// Months added to the ORIGINAL start each time, clamped to the month's last day,
// exactly as the platform works out renewals, so the two can never disagree
// about when a period begins.
function addMonths(date, months) {
  const target = new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth() + months, 1,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

/** The plan period `now` falls in: { from, to }, to being the next renewal. */
export function planPeriod(planStartedAt, billingPeriod, now = new Date()) {
  const start = toDate(planStartedAt);
  if (!start) return null;
  const step = billingPeriod === 'annual' ? 12 : 1;
  let n = 0;
  while (addMonths(start, n + step) <= now) n += step;
  return { from: addMonths(start, n), to: addMonths(start, n + step) };
}

/**
 * What is due to invoice now, as invoice lines in pounds, ex VAT:
 *
 *   - the plan fee for the plan period in progress, invoiced in advance: a
 *     month on a monthly plan, a year on an annual one;
 *   - the extra people from the last complete billing period, when there were
 *     any: last month on a monthly plan, last quarter on an annual one.
 *
 * `invoiced` is what has already been billed ({ kind, periodKey }), whether it
 * went on an invoice raised here or was marked as billed some other way.
 * `orders` are signed academy orders applied to this academy; a set-up fee on
 * one is due as soon as it is applied, even while the academy is still on its
 * trial, because the set-up work happens first.
 *
 * An academy paying by card (`card`, its subscription) is charged its plan by
 * Stripe, so there is no plan line; its extra people are still due, marked
 * `viaCard`, because they go on the card too rather than on an invoice.
 */
export function billingDue(academy, invoiced = [], now = new Date(), orders = [], { card = null } = {}) {
  if (!academy?.summary || academy.demo) return [];
  const done = new Set(invoiced.map((r) => `${r.kind}|${r.periodKey}`));
  const lines = [];
  for (const order of orders || []) {
    const fee = Math.round((Number(order.setupFee) || 0) * 100) / 100;
    const periodKey = `setup:${order.id}`;
    if (order.status === 'applied' && fee > 0 && !done.has(`setup|${periodKey}`)) {
      lines.push({
        kind: 'setup',
        periodKey,
        label: `Squideo Academy set-up${order.planName ? ` (${order.planName} plan)` : ''}`,
        amount: fee,
      });
    }
  }
  if (!isBilled(academy)) return lines;
  const s = academy.summary;
  const byCard = cardIsLive(card);

  const period = byCard ? null : planPeriod(s.planStartedAt, s.billingPeriod, now);
  if (period) {
    const periodKey = `plan:${isoDay(period.from)}`;
    if (!done.has(`plan|${periodKey}`)) {
      const annual = s.billingPeriod === 'annual';
      const last = new Date(period.to.getTime() - DAY);
      lines.push({
        kind: 'plan',
        periodKey,
        label: `Squideo Academy, ${s.plan.name} plan (${annual ? 'annual' : 'monthly'}), `
          + `${fmtDay(period.from)} to ${fmtDay(last)}`,
        amount: pounds(annual ? s.plan.annual : s.plan.monthly),
      });
    }
  }

  const statement = s.extra?.last;
  if (statement && statement.complete && Number(statement.total) > 0) {
    const periodKey = `extras:${statement.from}`;
    if (!done.has(`extras|${periodKey}`)) {
      lines.push({
        kind: 'extras',
        periodKey,
        label: `Squideo Academy, extra learners, ${statement.label}`,
        amount: pounds(statement.total),
        ...(byCard ? { viaCard: true } : {}),
      });
    }
  }
  return lines;
}

// ── Paying by card ──────────────────────────────────────────────────────────
//
// Starter and Team can be paid for by card: a Stripe subscription, charged in
// pence with VAT on top. Stripe's amounts include VAT; the invoice mirrored
// into Xero for each payment splits it back out.

// A subscription that is still taking payments, or will again.
export const LIVE_CARD_STATUSES = Object.freeze(['active', 'trialing', 'past_due', 'incomplete', 'cancelling']);

export const cardIsLive = (card) => Boolean(card && LIVE_CARD_STATUSES.includes(card.status));

/** What a card is charged, in pence, for an amount in pence ex VAT. */
export const grossPence = (exPence) => Math.round((Number(exPence) || 0) * (1 + VAT_RATE));

/** An amount a card was charged, in pence, split into its ex-VAT part and its VAT. */
export function splitGross(gross) {
  const total = Math.round(Number(gross) || 0);
  const exPence = Math.round(total / (1 + VAT_RATE));
  return { exPence, vatPence: total - exPence };
}

/**
 * How a Stripe subscription stands, in the platform's words: active,
 * trialing, past_due, incomplete, cancelling, or cancelled once it has ended.
 * A payment problem is said before a cancellation, because it is the one
 * somebody needs to act on.
 */
export function cardStatusFrom(sub) {
  if (!sub) return null;
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return 'cancelled';
  if (sub.status === 'past_due' || sub.status === 'unpaid' || sub.status === 'paused') return 'past_due';
  if (sub.status === 'incomplete') return 'incomplete';
  if (sub.cancel_at_period_end || sub.cancel_at) return 'cancelling';
  if (sub.status === 'trialing') return 'trialing';
  return 'active';
}

const fromSeconds = (s) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);

/** When a subscription next charges: the trial's end, or the end of the period. */
export function cardRenewsAt(sub) {
  if (!sub) return null;
  if (sub.status === 'trialing' && sub.trial_end) return fromSeconds(sub.trial_end);
  return fromSeconds(sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end);
}

/** The card state the academy platform stores, or null once it has ended. */
export function cardStateFor(sub) {
  const status = cardStatusFrom(sub);
  if (!status || status === 'cancelled') return null;
  return {
    status,
    renewsAt: cardRenewsAt(sub),
    cancelAt: status === 'cancelling' ? (fromSeconds(sub.cancel_at) || cardRenewsAt(sub)) : null,
  };
}

/**
 * A Stripe checkout that holds the first charge until a free trial ends:
 * only for a trial running more than two days yet, which is the notice Stripe
 * needs. Returns the trial's end in seconds, or null to charge today.
 */
export function holdUntilTrialEnds(trial, now = new Date()) {
  if (trial?.phase !== 'running' || !trial.endsAt) return null;
  const ends = toDate(trial.endsAt);
  if (!ends || ends.getTime() - now.getTime() <= 2 * DAY) return null;
  return Math.floor(ends.getTime() / 1000);
}

/**
 * What a card payment is for, as the line on its Xero invoice. `meta` is the
 * subscription's metadata (or the one-off invoice's, for extra people), and
 * `invoice` Stripe's invoice.
 */
export function cardPaymentLabel(meta, invoice) {
  if (meta?.kind === 'academy_extras') return meta.label || 'Squideo Academy, extra learners';
  const plan = `${meta?.planName || meta?.plan || 'Squideo Academy'} plan (${meta?.billingPeriod === 'annual' ? 'annual' : 'monthly'})`;
  if (invoice?.billing_reason === 'subscription_update') {
    return `Squideo Academy, change to the ${plan}, for the rest of the period, by card`;
  }
  const line = invoice?.lines?.data?.find((l) => l?.period?.start) || null;
  const from = fromSeconds(line?.period?.start);
  const to = fromSeconds(line?.period?.end);
  const dates = from && to ? `, ${fmtDay(from)} to ${fmtDay(new Date(new Date(to).getTime() - DAY))}` : '';
  return `Squideo Academy, ${plan}${dates}, by card`;
}

/** Barely used: a billed academy whose three-month average is a fifth of its allowance or less. */
export function isLowUsage(academy) {
  const s = academy?.summary;
  if (!isBilled(academy) || !(Number(s.cap) > 0)) return false;
  if ((s.usage?.months || []).length < 2 || s.usage.average === null || s.usage.average === undefined) return false;
  return s.usage.average <= s.cap * LOW_USAGE_SHARE;
}

// An annual renewal this close is worth a conversation. A monthly plan renews
// every month, which is what its invoice is for, not something to flag.
function renewalSoon(academy, now) {
  const s = academy.summary;
  // A card renews itself; there is nothing to chase.
  if (!isBilled(academy) || s.billingPeriod !== 'annual' || cardIsLive(academy.card)) return null;
  const renews = toDate(s.renewsAt);
  if (!renews) return null;
  const days = Math.ceil((renews.getTime() - now.getTime()) / DAY);
  return days >= 0 && days <= ALERT_WINDOW_DAYS ? { renews, days } : null;
}

/** What needs somebody's attention, most pressing first, for the page and the card. */
export function academyFlags(academy, due = [], now = new Date()) {
  const s = academy?.summary;
  if (!s) return [];
  const flags = [];
  // What goes on the card is charged by the daily job, not waiting on anybody.
  const dueTotal = round2(due.filter((l) => !l.viaCard).reduce((sum, l) => sum + l.amount, 0));
  if (dueTotal > 0) flags.push({ kind: 'to_invoice', label: `£${dueTotal.toFixed(2)} to invoice` });
  if (s.request) flags.push({ kind: 'requested', label: `Asked for ${s.request.plan?.name || 'a plan'}` });
  if (s.trial?.phase === 'running' && s.trial.daysLeft <= ALERT_WINDOW_DAYS) {
    flags.push({ kind: 'trial_ending', label: `Trial ends in ${s.trial.daysLeft} day${s.trial.daysLeft === 1 ? '' : 's'}` });
  }
  if (academy.card?.status === 'past_due' || academy.card?.status === 'incomplete') {
    flags.push({ kind: 'card_failed', label: 'Card payment failed' });
  }
  const renewal = renewalSoon(academy, now);
  if (renewal) flags.push({ kind: 'renewal', label: `Renews ${fmtDay(renewal.renews)}` });
  if (isBilled(academy) && s.check?.overTwoMonths) flags.push({ kind: 'over', label: 'Over its allowance two months running' });
  if (isLowUsage(academy)) flags.push({ kind: 'low_usage', label: 'Low usage' });
  return flags;
}

/**
 * The alerts an academy should raise today, each with the key it is sent under
 * once: a trial ending once per trial, a request once per request, a renewal
 * once per renewal date, and outgrowing or barely using a plan once a quarter
 * for as long as it lasts, so an ongoing state is a reminder rather than noise.
 */
export function alertsFor(academy, now = new Date()) {
  const s = academy?.summary;
  if (!s || academy.demo) return [];
  const out = [];
  if (s.trial?.phase === 'running' && s.trial.daysLeft <= ALERT_WINDOW_DAYS && s.trial.endsAt) {
    out.push({ kind: 'trial_ending', periodKey: String(s.trial.endsAt).slice(0, 10) });
  }
  if (s.request?.plan) {
    out.push({ kind: 'plan_requested', periodKey: `${s.request.plan.slug}:${s.request.at || ''}` });
  }
  if (isBilled(academy) && s.check?.overTwoMonths) out.push({ kind: 'over_allowance', periodKey: quarterKey(now) });
  if (isLowUsage(academy)) out.push({ kind: 'low_usage', periodKey: quarterKey(now) });
  const renewal = renewalSoon(academy, now);
  if (renewal) out.push({ kind: 'renewal_due', periodKey: isoDay(renewal.renews) });
  return out;
}

/**
 * The figures across the top of the Academies page. `rows` are academies with
 * their `due` lines already worked out.
 */
export function academyTotals(rows, now = new Date()) {
  const month = monthKey(now);
  let mrrPence = 0;
  let paying = 0;
  let trials = 0;
  let trialsEndingThisMonth = 0;
  let requests = 0;
  let toInvoice = 0;
  let toInvoiceCount = 0;
  let needsAttention = 0;
  for (const a of rows || []) {
    const s = a.summary || {};
    if (isBilled(a)) {
      paying += 1;
      mrrPence += Number(a.monthlyValue) || 0;
    }
    if (!a.demo && (s.trial?.phase === 'running' || s.trial?.phase === 'waiting')) {
      trials += 1;
      const ends = toDate(s.trial?.endsAt);
      if (ends && monthKey(ends) === month) trialsEndingThisMonth += 1;
    }
    if (s.request) requests += 1;
    const due = round2((a.due || []).filter((l) => !l.viaCard).reduce((sum, l) => sum + l.amount, 0));
    if (due > 0) {
      toInvoice += due;
      toInvoiceCount += 1;
    }
    if ((a.flags || []).length) needsAttention += 1;
  }
  const mrr = pounds(mrrPence);
  return {
    mrr,
    arr: round2(mrr * 12),
    paying,
    trials,
    trialsEndingThisMonth,
    requests,
    toInvoice: round2(toInvoice),
    toInvoiceCount,
    needsAttention,
  };
}
