// Is this payment NEWS, or something we've only just noticed?
//
// Both invoice-paid alerts fire off a Xero sync, and a sync doesn't discover
// things in the order they happened. An invoice paid on the 12th can sit in our
// database as "issued" until someone opens the invoices page on the 20th — at
// which point we'd announce "💰 Invoice paid" as though the money had just
// landed. It has not. Someone reads that as cash arriving today, tells the
// team, and now two people believe a thing that isn't true.
//
// So the alert has to say which of the two it is. Three bands:
//
//   fresh    — paid in the last couple of days. Announce it plainly; the sync
//              lagging by an hour or overnight is normal and not worth a caveat.
//   catch-up — older than that. Still worth telling people, because otherwise a
//              payment we learn about late is a payment nobody is told about at
//              all. But it leads with the DATE, so it can't be mistaken for
//              money that arrived this morning.
//   historic — older than a month. Not news by any reading. Recorded silently.
//              This band is also what makes a first sync after a deploy safe:
//              without it, switching on a new alert would announce every
//              already-paid invoice in the database at once.
//
// No DB and no clock of its own (the caller passes `now`), so the bands can be
// tested rather than waited for.

export const FRESH_DAYS = 2;
export const HISTORIC_DAYS = 30;

const DAY_MS = 86400000;

// en-GB long date, e.g. "12 August". The year is added only when it isn't this
// one — "paid on 12 August 2025" and "paid on 12 August" are different facts.
export function paidOnLabel(paidAt, now = Date.now()) {
  const d = new Date(paidAt);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC',
  });
}

// { band, days, paidOn } — band is 'fresh' | 'catch-up' | 'historic'.
//
// An unparseable or missing date is treated as FRESH rather than historic:
// staying quiet about a real payment is the worse mistake, and a missing
// paid_at usually means "just now, we didn't get a date back".
export function paymentFreshness(paidAt, now = Date.now()) {
  const t = paidAt ? new Date(paidAt).getTime() : NaN;
  if (!Number.isFinite(t)) return { band: 'fresh', days: 0, paidOn: null };

  // A date-only value from Xero ("2026-08-12") parses to midnight UTC, so an
  // invoice paid earlier today reads as a few hours old, not negative. A future
  // date (clock skew, a forward-dated payment) is clamped to 0 rather than
  // going negative and landing in the wrong band.
  const days = Math.max(0, (now - t) / DAY_MS);
  const band = days > HISTORIC_DAYS ? 'historic' : days > FRESH_DAYS ? 'catch-up' : 'fresh';
  return { band, days, paidOn: paidOnLabel(paidAt, now) };
}

// The subject line, given the band. Keeps the two callers wording it the same
// way — the whole point being that "paid" and "we've just noticed it was paid"
// must not look alike.
export function paidSubject(title, freshness) {
  if (freshness.band === 'fresh' || !freshness.paidOn) return `💰 Invoice paid: ${title}`;
  return `💰 Invoice paid on ${freshness.paidOn}: ${title}`;
}

// One sentence to put at the top of a catch-up alert. Null when it's fresh.
export function catchUpNote(freshness) {
  if (freshness.band === 'fresh' || !freshness.paidOn) return null;
  return `We've only just picked this up from Xero — it was paid on ${freshness.paidOn}, not today.`;
}
