// Self-serve signup for The Explainer Video Planning Crash Course.
//
// This is the FIRST and ONLY place in the product where an account is created
// without an invite. Everything else — clients, colleagues, staff — comes in
// through a token someone at Squideo issued. That makes this the one public
// door into the portal, so it is written defensively.
//
// ═══ THE RULE THAT MATTERS ═══════════════════════════════════════════════════
// A course signup NEVER resolves an existing company. It only ever creates a
// fresh `prospect` one.
//
// qualifyQuoteRequest() matches companies by work-email domain, which is right
// for a STAFF-initiated qualification — a human is looking at the lead. Doing
// the same here would mean anyone who can type `someone@acme.co.uk` into a
// public form lands inside ACME's real client portal and reads their projects,
// files and videos. There is no version of this feature worth that.
//
// The same reasoning rules out a single shared "Course members" org: every
// member of a company can see every other member on the Team page.
// ═════════════════════════════════════════════════════════════════════════════

import sql from '../db.js';
import { makeId, trimOrNull, lowerOrNull } from '../crm/shared.js';
import { isDisposableEmail } from '../disposableEmail.js';
import { pickAttribution } from '../leadAttribution.js';
import { companyNameFromEmail, resolveContactForSigner } from '../portal/onboarding.js';
import { applyTag } from '../crm/tags.js';
import { ensureCourseTables } from './db.js';

const SIGNUPS_PER_HOUR_PER_IP = 5;
const SIGNUPS_PER_DAY_PER_IP = 20;

// Rough shape check only. The address is proven by the magic link they get on a
// return visit, not by a regex — over-strict validation rejects real people
// (plus-addressing, new TLDs, apostrophes) far more often than it stops abuse.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class SignupError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── Rate limit ───────────────────────────────────────────────────────────────
// Mirrors portal_failed_logins: a counter per (ip, window), where a window is
// simply a truncated hour. Rows outside the window are ignored rather than
// swept — there's no cron for it and the table stays tiny.
async function assertNotThrottled(ip) {
  if (!ip || ip === 'unknown') return;
  const [row] = await sql`
    SELECT
      COALESCE(SUM(attempts) FILTER (WHERE window_start > NOW() - INTERVAL '1 hour'), 0)::int AS hour,
      COALESCE(SUM(attempts) FILTER (WHERE window_start > NOW() - INTERVAL '1 day'),  0)::int AS day
      FROM course_signup_throttle WHERE ip = ${ip}
  `;
  if ((row?.hour ?? 0) >= SIGNUPS_PER_HOUR_PER_IP || (row?.day ?? 0) >= SIGNUPS_PER_DAY_PER_IP) {
    throw new SignupError(429, "That's a lot of sign-ups from one place. Try again a bit later, or email enquiries@squideo.co.uk.");
  }
}

async function recordAttempt(ip) {
  if (!ip || ip === 'unknown') return;
  await sql`
    INSERT INTO course_signup_throttle (ip, window_start, attempts)
    VALUES (${ip}, date_trunc('hour', NOW()), 1)
    ON CONFLICT (ip, window_start) DO UPDATE
      SET attempts = course_signup_throttle.attempts + 1
  `;
}

// ── The prospect organisation ────────────────────────────────────────────────
// Always freshly created. Named from the work-email domain, then whatever they
// typed, then their own name — a personal address becomes "Jane Smith", never
// "Gmail". Flagged `prospect` so the CRM's company list can exclude it: a few
// hundred of these would otherwise make the Organisations tab unusable.
async function createProspectCompany({ email, name, companyName }) {
  const label = companyNameFromEmail(email)
    || trimOrNull(companyName)
    || trimOrNull(name)
    || lowerOrNull(email);
  const id = makeId('co');
  await sql`
    INSERT INTO companies (id, name, prospect, source)
    VALUES (${id}, ${label}, TRUE, 'course')
  `;
  return { id, name: label };
}

// ── Main entry ───────────────────────────────────────────────────────────────
// Returns { outcome, user, signupId }.
//   'created'  → brand new account; the caller signs them straight in.
//   'existing' → the email already has a portal account. The caller must NOT
//                issue a session (that would hand anyone a login for any
//                address they can guess) — it sends a magic link instead.
export async function createCourseSignup({
  email: rawEmail, name: rawName, companyName, marketingConsent, consentText,
  attribution, ip, honeypot,
}) {
  await ensureCourseTables();

  // Bots fill in every field they can see, including the one positioned off
  // screen. Silently succeed rather than erroring — telling a bot it was
  // detected only teaches it to try again differently.
  if (trimOrNull(honeypot)) {
    return { outcome: 'created', user: null, signupId: null, silent: true };
  }

  const email = lowerOrNull(rawEmail);
  const name = trimOrNull(rawName);
  if (!email || !EMAIL_RE.test(email)) throw new SignupError(400, 'Enter a valid email address');
  if (!name) throw new SignupError(400, 'Enter your name');
  if (isDisposableEmail(email)) {
    throw new SignupError(400, 'Please use an email address we can actually reach you on.');
  }

  await assertNotThrottled(ip);
  await recordAttempt(ip);

  const [existing] = await sql`
    SELECT id, email, name, token_version, disabled_at FROM portal_users WHERE email = ${email}
  `;

  if (existing) {
    // A disabled account gets the same answer as a live one, and nothing is
    // sent. Whatever got them disabled shouldn't be undone by a course form.
    if (existing.disabled_at) return { outcome: 'existing', user: null, signupId: null };
    // They already have an account, so they already have the course — every
    // signed-in portal user does. Record the interest and let the caller mail
    // them a link. No new company, no password change, no session.
    const signupId = await upsertSignupRow({
      email, name, companyName, portalUserId: existing.id,
      contactId: null, companyId: null, marketingConsent, consentText, attribution, ip,
    });
    return { outcome: 'existing', user: existing, signupId };
  }

  const company = await createProspectCompany({ email, name, companyName });
  const contact = await resolveContactForSigner({
    email, name, companyId: company.id, source: 'course',
  });

  const userId = makeId('pu');
  await sql`
    INSERT INTO portal_users (id, email, name, password_hash, contact_id)
    VALUES (${userId}, ${email}, ${name}, NULL, ${contact?.id || null})
  `;
  await sql`
    INSERT INTO portal_memberships (portal_user_id, company_id, invited_by)
    VALUES (${userId}, ${company.id}, 'system:course')
    ON CONFLICT (portal_user_id, company_id) DO NOTHING
  `;

  const signupId = await upsertSignupRow({
    email, name, companyName, portalUserId: userId,
    contactId: contact?.id || null, companyId: company.id,
    marketingConsent, consentText, attribution, ip,
  });

  // Best-effort by design — applyTag swallows its own errors. A tagging
  // failure must never cost someone the account they just created.
  await applyTag(contact?.id, 'course-signup', {
    label: 'Course signup', colour: '#2BB8E6', by: 'system:course',
  });

  const [user] = await sql`
    SELECT id, email, name, token_version, disabled_at FROM portal_users WHERE id = ${userId}
  `;
  return { outcome: 'created', user, signupId, companyId: company.id };
}

// password_hash is deliberately NULL above: the course signup asks for a name
// and an email and nothing else. Dropping the password field (and the
// "check your email" wall behind it) is the single biggest conversion lever on
// the page. They set one later in Settings if they want; until then a magic
// link is how they get back in.

async function upsertSignupRow({
  email, name, companyName, portalUserId, contactId, companyId,
  marketingConsent, consentText, attribution, ip,
}) {
  const attr = pickAttribution({ attribution }) || {};
  const id = makeId('csu');

  // ON CONFLICT keeps the FIRST signup's attribution and consent evidence.
  // Someone who signs up twice was earned by the first touch, and the consent
  // record must reflect the moment they actually ticked the box.
  const [row] = await sql`
    INSERT INTO course_signups (
      id, email, name, company_name, portal_user_id, contact_id, company_id,
      marketing_consent, consent_text, consent_ip, consent_at, consent_source,
      attr_channel, attr_source, attr_medium, attr_campaign, attr_term, attr_content,
      attr_gclid, attr_gbraid, attr_wbraid, attr_fbclid, attr_msclkid,
      attr_campaign_id, attr_adgroup_id, attr_keyword, attr_matchtype,
      attr_network, attr_device, attr_landing_url, attr_referrer, attr_first_seen_at
    ) VALUES (
      ${id}, ${email}, ${name}, ${trimOrNull(companyName)}, ${portalUserId},
      ${contactId}, ${companyId},
      ${marketingConsent === true}, ${trimOrNull(consentText)}, ${ip || null},
      ${marketingConsent === true ? new Date() : null}, 'course_landing',
      ${attr.attr_channel ?? null}, ${attr.attr_source ?? null}, ${attr.attr_medium ?? null},
      ${attr.attr_campaign ?? null}, ${attr.attr_term ?? null}, ${attr.attr_content ?? null},
      ${attr.attr_gclid ?? null}, ${attr.attr_gbraid ?? null}, ${attr.attr_wbraid ?? null},
      ${attr.attr_fbclid ?? null}, ${attr.attr_msclkid ?? null},
      ${attr.attr_campaign_id ?? null}, ${attr.attr_adgroup_id ?? null},
      ${attr.attr_keyword ?? null}, ${attr.attr_matchtype ?? null},
      ${attr.attr_network ?? null}, ${attr.attr_device ?? null},
      ${attr.attr_landing_url ?? null}, ${attr.attr_referrer ?? null},
      ${attr.attr_first_seen_at ?? null}
    )
    ON CONFLICT (LOWER(email)) DO UPDATE SET
      portal_user_id = COALESCE(course_signups.portal_user_id, EXCLUDED.portal_user_id),
      contact_id     = COALESCE(course_signups.contact_id,     EXCLUDED.contact_id),
      company_id     = COALESCE(course_signups.company_id,     EXCLUDED.company_id),
      name           = COALESCE(course_signups.name,           EXCLUDED.name),
      -- Consent can only ever be granted here, never silently revoked by a
      -- second visit where the box happened to be unticked.
      marketing_consent = course_signups.marketing_consent OR EXCLUDED.marketing_consent,
      consent_text   = COALESCE(course_signups.consent_text, EXCLUDED.consent_text),
      consent_at     = COALESCE(course_signups.consent_at,   EXCLUDED.consent_at),
      consent_ip     = COALESCE(course_signups.consent_ip,   EXCLUDED.consent_ip)
    RETURNING id
  `;
  return row?.id || null;
}
