// The Monthly Plan proposal type.
//
// A client commits to a monthly spend from the start, with no project purchase
// up front: "£300 + VAT per month". They still see what's included the way any
// proposal shows it, but the thing they sign is the commitment itself rather
// than a piece of work with a subscription bolted on.
//
// Two things distinguish it from the existing Partner Programme:
//
//   1. There is no project. basePrice is £0, the client cannot opt out of the
//      programme (signing IS the opt-in), and the monthly figure is fixed by
//      whoever built the proposal rather than dialled by the client.
//   2. The rate is stated, not laddered. The tier discount exists to reward
//      buying more minutes at once, and there is nothing to reward here — the
//      monthly amount is the deal. So the rate per minute is entered directly
//      and no discount is applied to it.
//
// FRONT-LOADING is the commercially interesting part. A client paying for one
// minute a month waits a long time before there is anything to watch, which is
// a bad way to start a relationship. So we can agree to produce up to N minutes
// immediately and let the monthly payments cover it. The credit ledger already
// models this correctly with no new concept: issued − used simply goes
// NEGATIVE, and each paid month brings it back towards zero.
//
// That is also why the minimum term exists. An advance is only safe if the
// client cannot leave before it is paid off, so a term is required whenever
// front-loading is on, and it must be at least as long as the advance takes to
// clear. Without front-loading there is nothing to protect and the plan is
// cancel-any-time, like the original programme.
//
// This module is imported by BOTH the client proposal view and the server-side
// checkout recompute. It is deliberately not a fourth copy of the pricing rules
// in the src/api mirror: that mirror already has to be kept in step by hand,
// and every figure below is one a client signs and a card is charged for.

export const MONTHLY_MODE = 'monthly';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

export function isMonthlyPlan(data) {
  return data?.partnerProgramme?.mode === MONTHLY_MODE;
}

/**
 * Everything a monthly plan is worth, from the PROPOSAL alone.
 *
 * Nothing here reads a signature. On a standard proposal the client chooses how
 * many credits to take, so that number has to come from what they signed; on a
 * monthly plan the commitment is fixed when the proposal is built, so taking it
 * from the signature would only create a way to sign up for less than the
 * proposal says.
 */
export function monthlyPlanFor(data) {
  const pp = data?.partnerProgramme || {};

  // Half-minute granularity, matching the minutes input everywhere else. A plan
  // of zero minutes is a plan that bills for nothing, so it floors at a half —
  // and "not set yet" has to be told apart from "set to zero", or a `|| 1`
  // would quietly turn an emptied field into a one-minute plan.
  const rawMinutes = pp.minutesPerMonth === undefined || pp.minutesPerMonth === null
    ? 1
    : num(pp.minutesPerMonth);
  const minutesPerMonth = Math.max(0.5, Math.round(rawMinutes * 2) / 2);
  // Falls back to the standard rate so a plan built before the dedicated field
  // existed, or converted from another type, still prices rather than showing
  // £0 per month.
  const ratePerMin = Math.max(0, num(pp.monthlyRatePerMin ?? pp.standardRatePerMin));
  const monthlyExVat = round2(minutesPerMonth * ratePerMin);

  const frontLoadMinutes = Math.max(0, num(pp.frontLoadMinutes));
  const frontLoadValue = round2(frontLoadMinutes * ratePerMin);
  // How many months of payment the advance represents, and therefore how long
  // it takes to clear. Rounded UP: half a month of outstanding advance still
  // needs a whole month's payment to cover it.
  const payOffMonths = minutesPerMonth > 0 ? Math.ceil(frontLoadMinutes / minutesPerMonth) : 0;

  const minTermMonths = Math.max(0, Math.round(num(pp.minTermMonths)));
  const commitmentExVat = round2(monthlyExVat * minTermMonths);

  return {
    minutesPerMonth,
    ratePerMin,
    monthlyExVat,
    frontLoadMinutes,
    frontLoadValue,
    payOffMonths,
    minTermMonths,
    commitmentExVat,
    // A term is only meaningful when there is something to protect.
    hasFrontLoad: frontLoadMinutes > 0,
    hasTerm: minTermMonths > 0,
  };
}

/**
 * What is wrong with this plan as configured, for the builder to show.
 *
 * Returns an array of plain sentences, empty when it is sound. These are
 * author-facing: every one of them is a way to put a number in front of a
 * client that the business cannot honour.
 */
export function monthlyPlanProblems(data) {
  const plan = monthlyPlanFor(data);
  const out = [];

  if (!(plan.ratePerMin > 0)) {
    out.push('Set the monthly rate per minute — the plan currently prices at £0 a month.');
  }

  if (plan.hasFrontLoad) {
    if (!plan.hasTerm) {
      // The whole reason a term exists on this proposal type.
      out.push(
        `Front-loading ${plan.frontLoadMinutes} minutes needs a minimum term. `
        + `Without one the client can cancel next month having had `
        + `${plan.frontLoadMinutes} minutes of production for one payment.`,
      );
    } else if (plan.minTermMonths < plan.payOffMonths) {
      out.push(
        `The minimum term of ${plan.minTermMonths} months is shorter than the `
        + `${plan.payOffMonths} months it takes to pay off ${plan.frontLoadMinutes} `
        + 'minutes produced in advance.',
      );
    }
  }

  return out;
}

/**
 * The line the proposal shows the client about the advance, or null.
 *
 * Written as a promise the business is making rather than a mechanism, because
 * that is what it is: we start now, you pay the same either way.
 */
export function frontLoadSummary(data) {
  const plan = monthlyPlanFor(data);
  if (!plan.hasFrontLoad) return null;
  const mins = plan.frontLoadMinutes;
  const label = `${mins % 1 === 0 ? mins.toFixed(0) : String(mins)} ${mins === 1 ? 'minute' : 'minutes'}`;
  return {
    minutes: plan.frontLoadMinutes,
    label,
    payOffMonths: plan.payOffMonths,
  };
}
