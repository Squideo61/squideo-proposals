// An invoice paid on the 12th, announced on the 20th as "💰 Invoice paid",
// read to the team as cash arriving that morning. It hadn't. Someone repeated
// it in Slack and then two people believed it.
//
// The bands here are the fix: a sync discovers things out of order, so an alert
// off the back of one has to say whether it's news or a catch-up. Pinned
// because the boundaries are the whole substance — get them wrong in one
// direction and old payments read as new money, in the other and real payments
// go unannounced.
import { describe, it, expect } from 'vitest';
import {
  paymentFreshness, paidSubject, catchUpNote, paidOnLabel,
  FRESH_DAYS, HISTORIC_DAYS,
} from '../api/_lib/crm/paymentFreshness.js';

const NOW = Date.parse('2026-08-20T15:11:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

describe('paymentFreshness', () => {
  it('treats a payment from today or yesterday as news', () => {
    expect(paymentFreshness(daysAgo(0), NOW).band).toBe('fresh');
    expect(paymentFreshness(daysAgo(1), NOW).band).toBe('fresh');
    // The sync lagging overnight is normal and not worth a caveat.
    expect(paymentFreshness(daysAgo(FRESH_DAYS), NOW).band).toBe('fresh');
  });

  it('treats last week as a catch-up, not as news', () => {
    // This is the Anglia Ruskin case: paid on the 12th, noticed on the 20th.
    const f = paymentFreshness('2026-08-12', NOW);
    expect(f.band).toBe('catch-up');
    expect(f.paidOn).toBe('12 August');
  });

  it('stays silent about anything a month old', () => {
    expect(paymentFreshness(daysAgo(HISTORIC_DAYS + 1), NOW).band).toBe('historic');
    // …which is also what stops a first sync after deploy announcing every
    // invoice ever paid, all at once.
    expect(paymentFreshness(daysAgo(400), NOW).band).toBe('historic');
  });

  it('errs towards speaking up when the date is missing or unreadable', () => {
    // Silence about a real payment is the worse mistake, and a missing paid_at
    // usually means "just now, Xero didn't give us a date".
    expect(paymentFreshness(null, NOW).band).toBe('fresh');
    expect(paymentFreshness('not a date', NOW).band).toBe('fresh');
  });

  it('does not let a forward-dated payment fall into the wrong band', () => {
    // Clock skew between us and Xero shouldn't be able to produce a negative
    // age, which would otherwise sail past every threshold.
    const f = paymentFreshness(new Date(NOW + 5 * 86400000).toISOString(), NOW);
    expect(f.band).toBe('fresh');
    expect(f.days).toBe(0);
  });

  it('names the year only when it is not this one', () => {
    expect(paidOnLabel('2026-08-12', NOW)).toBe('12 August');
    expect(paidOnLabel('2025-08-12', NOW)).toBe('12 August 2025');
  });
});

describe('what the alert actually says', () => {
  it('says nothing extra when the money just arrived', () => {
    const f = paymentFreshness(daysAgo(0), NOW);
    expect(paidSubject('Anglia Ruskin University', f)).toBe('💰 Invoice paid: Anglia Ruskin University');
    expect(catchUpNote(f)).toBeNull();
  });

  it('leads with the date when it did not', () => {
    const f = paymentFreshness('2026-08-12', NOW);
    // The date is in the SUBJECT, because that's the part that gets read on a
    // lock screen and repeated to the team.
    expect(paidSubject('Anglia Ruskin University', f))
      .toBe('💰 Invoice paid on 12 August: Anglia Ruskin University');
    expect(catchUpNote(f)).toContain('only just picked this up');
    expect(catchUpNote(f)).toContain('12 August');
    expect(catchUpNote(f)).toContain('not today');
  });
});
