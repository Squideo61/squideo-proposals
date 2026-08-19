// Which form on squideo.com a lead came off.
//
// Shared between the public endpoint that writes it (api/quote-requests.js) and
// the admin route that reads it back (api/quote-requests-admin.js), so the
// self-heal lives in one place and both sides agree on what a valid value is.
//
// The marketing site is moving off Duda, and nine of its pages had Duda-native
// forms that Duda itself captured — a free script request, two discovery
// meeting bookings, a brief template, a video amends form, a free consultation,
// a LinkedIn offer, an interactive-video enquiry and an AI-translation enquiry.
// The rebuilt site posts all nine into /api/quote-requests, so without a
// discriminator every one of them lands in the "new" inbox looking exactly like
// a quote request.
//
// NOT the existing `source` column, which is 'web' | 'portal' and answers a
// different question that the Marketing reporting already depends on. One of
// these forms is `source = 'web'` AND `form_source = 'linkedin-offer'`.
import sql from './db.js';

// A slug, validated rather than allowlisted. The list of forms belongs to the
// marketing repo; an allowlist here would mean a new landing page silently
// loses its label until somebody remembers to edit a second codebase.
const FORM_SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const pickFormSource = (v) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return FORM_SOURCE_RE.test(s) ? s : null;
};

// The readable version, for the team notification's subject line — "New free
// script request from …" rather than "New quote request". Sent by the caller
// for the same reason the slug is not allowlisted. Clipped and stripped of
// newlines because it lands in an email header.
export const pickFormLabel = (v) => {
  const s = typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return s ? s.slice(0, 60) : null;
};

/*
 * Self-heal the column, so neither the first lead off the rebuilt site nor the
 * admin list that reads it can hit a missing one if
 * 20260819_quote_request_form_source.sql has not been run.
 *
 * MUST NEVER REJECT. A rejected ensure() here would take out the public lead
 * endpoint and the whole quote-requests inbox — which is exactly how a
 * self-heal meant to prevent an outage has caused one before. It resolves
 * either way and clears the memo on failure so the next request tries again.
 */
let ensured = null;
export function ensureFormSource() {
  if (ensured) return ensured;
  ensured = (async () => {
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS form_source TEXT`;
  })().catch((e) => {
    console.warn('[quote-requests] form_source ensure failed', e?.message);
    ensured = null;
  });
  return ensured;
}
