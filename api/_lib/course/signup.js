// Self-serve signup for the Free 6-Min Video Guide.
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
import { sendNotification, ensureCourseSignupNotificationDefault } from '../notifications.js';
import { internalEmails, isInternalEmail } from '../internalAccounts.js';
import { companyNameFromEmail, resolveContactForSigner } from '../portal/onboarding.js';
import { applyTag } from '../crm/tags.js';
import { ensureCourseTables } from './db.js';

const SIGNUPS_PER_HOUR_PER_IP = 5;
const SIGNUPS_PER_DAY_PER_IP = 20;

// ── The public doors ─────────────────────────────────────────────────────────
// Everything that differs between them lives here, so the signup body below has
// no idea which page it is serving. Adding a third lead magnet is a new entry,
// not a new branch through defensive code that took care to get right once.
//
// The throttle, the disposable-address check, the never-resolve-an-existing-
// company rule and the consent record are shared BECAUSE they are shared — they
// are properties of "a stranger typed their email into a public form", not of
// any one campaign.
//
// They all notify on the same `course.signup` key rather than one key each: the
// audience is identical (whoever wants to know a stranger just arrived), and a
// new key would need its own notification default and its own subscription
// before anyone heard about a lead. Only the wording differs.
const SIGNUP_SOURCES = {
  course: {
    companySource: 'course',
    contactSource: 'course',
    invitedBy: 'system:course',
    consentSource: 'course_landing',
    tag: { slug: 'course-signup', label: 'Course signup', colour: '#2BB8E6' },
    notify: {
      emoji: '🎓',
      noun: 'Video guide signup',
      verb: 'signed up for the 6-Min Video Guide',
      // Each magnet reports on its own Marketing tab. Both used to point at the
      // course tab, so a brief signup opened a page about the other magnet.
      link: '#/marketing/course',
    },
  },
  brief: {
    companySource: 'brief',
    contactSource: 'brief',
    invitedBy: 'system:brief',
    consentSource: 'brief_landing',
    tag: { slug: 'brief-signup', label: 'Brief builder', colour: '#7C5CD1' },
    notify: {
      emoji: '📝',
      noun: 'Brief builder signup',
      verb: 'started a video brief',
      link: '#/marketing/briefs',
    },
  },
};

// Unknown source falls back to 'course' rather than throwing: a typo in a
// caller must not cost someone the account they just created, and 'course' is
// the conservative label — it under-claims the new door rather than inventing
// a category the reports don't know about.
const sourceConfig = (source) => SIGNUP_SOURCES[source] || SIGNUP_SOURCES.course;

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
async function createProspectCompany({ email, name, companyName, cfg }) {
  const label = companyNameFromEmail(email)
    || trimOrNull(companyName)
    || trimOrNull(name)
    || lowerOrNull(email);
  const id = makeId('co');
  await sql`
    INSERT INTO companies (id, name, prospect, source)
    VALUES (${id}, ${label}, TRUE, ${cfg.companySource})
  `;
  return { id, name: label };
}

// ── Main entry ───────────────────────────────────────────────────────────────
// Returns { outcome, user, signupId }.
//   'created'  → brand new account; the caller signs them straight in.
//   'existing' → the email already has a portal account. The caller must NOT
//                issue a session (that would hand anyone a login for any
//                address they can guess) — it sends a magic link instead.
export async function createPortalSignup({
  email: rawEmail, name: rawName, companyName, marketingConsent, consentText,
  attribution, ip, honeypot, source = 'course',
}) {
  await ensureCourseTables();
  const cfg = sourceConfig(source);
  const signupSource = SIGNUP_SOURCES[source] ? source : 'course';

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
      cfg, signupSource,
    });
    return { outcome: 'existing', user: existing, signupId };
  }

  const company = await createProspectCompany({ email, name, companyName, cfg });
  const contact = await resolveContactForSigner({
    email, name, companyId: company.id, source: cfg.contactSource,
  });

  const userId = makeId('pu');
  await sql`
    INSERT INTO portal_users (id, email, name, password_hash, contact_id)
    VALUES (${userId}, ${email}, ${name}, NULL, ${contact?.id || null})
  `;
  await sql`
    INSERT INTO portal_memberships (portal_user_id, company_id, invited_by)
    VALUES (${userId}, ${company.id}, ${cfg.invitedBy})
    ON CONFLICT (portal_user_id, company_id) DO NOTHING
  `;

  const signupId = await upsertSignupRow({
    email, name, companyName, portalUserId: userId,
    contactId: contact?.id || null, companyId: company.id,
    marketingConsent, consentText, attribution, ip, cfg, signupSource,
  });

  // Best-effort by design — applyTag swallows its own errors. A tagging
  // failure must never cost someone the account they just created.
  await applyTag(contact?.id, cfg.tag.slug, {
    label: cfg.tag.label, colour: cfg.tag.colour, by: cfg.invitedBy,
  });

  const [user] = await sql`
    SELECT id, email, name, token_version, disabled_at FROM portal_users WHERE id = ${userId}
  `;
  return { outcome: 'created', user, signupId, companyId: company.id };
}

// The video guide was the first door and is still the busiest one, so it keeps
// a name of its own rather than every call site spelling out the source.
export const createCourseSignup = (args) => createPortalSignup({ ...args, source: 'course' });

// password_hash is deliberately NULL above: the course signup asks for a name
// and an email and nothing else. Dropping the password field (and the
// "check your email" wall behind it) is the single biggest conversion lever on
// the page. They set one later in Settings if they want; until then a magic
// link is how they get back in.

async function upsertSignupRow({
  email, name, companyName, portalUserId, contactId, companyId,
  marketingConsent, consentText, attribution, ip, cfg, signupSource,
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
      signup_source,
      attr_channel, attr_source, attr_medium, attr_campaign, attr_term, attr_content,
      attr_gclid, attr_gbraid, attr_wbraid, attr_fbclid, attr_msclkid,
      attr_campaign_id, attr_adgroup_id, attr_keyword, attr_matchtype,
      attr_network, attr_device, attr_landing_url, attr_referrer, attr_first_seen_at
    ) VALUES (
      ${id}, ${email}, ${name}, ${trimOrNull(companyName)}, ${portalUserId},
      ${contactId}, ${companyId},
      ${marketingConsent === true}, ${trimOrNull(consentText)}, ${ip || null},
      ${marketingConsent === true ? new Date() : null}, ${cfg.consentSource},
      ${signupSource},
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
    -- signup_source is deliberately absent from the DO UPDATE, for the same
    -- reason as the attribution: whoever came in through the course and later
    -- filled in a brief was earned by the course.
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
  const signupId = row?.id || null;

  // Tell the team — but only the first time, and only for a real stranger.
  //
  // `id = ${id}` is the test for "new": ON CONFLICT returns the EXISTING row's
  // id when the address is already on the list, so a second signup from the
  // same person comes back with a different id to the one we just generated.
  // Without that check, anyone re-signing-up would ping the team again.
  if (signupId === id) {
    notifyNewSignup({ signupId, email, name, companyName, attr, cfg }).catch(() => {});
  }
  return signupId;
}

// Best-effort and never awaited by the caller: a signup must complete whether
// or not anyone can be told about it.
async function notifyNewSignup({ signupId, email, name, companyName, attr, cfg }) {
  try {
    // Our own testing shouldn't buzz anyone's phone.
    const ourEmails = await internalEmails().catch(() => []);
    if (isInternalEmail(email, ourEmails)) return;

    await ensureCourseSignupNotificationDefault();
    const who = trimOrNull(name) || email;
    const where = attr?.attr_campaign || attr?.attr_source || null;
    await sendNotification('course.signup', {
      subject: `${cfg.notify.emoji} ${cfg.notify.noun} — ${who}${companyName ? ` (${companyName})` : ''}`,
      text: [
        `${who} ${cfg.notify.verb}.`,
        '',
        `Email: ${email}`,
        companyName ? `Company: ${companyName}` : null,
        where ? `Came from: ${where}` : null,
      ].filter(Boolean).join('\n'),
      inApp: {
        title: `${cfg.notify.noun} — ${who}`,
        // Kept short: this is the line a phone shows on the lock screen.
        body: [companyName, where].filter(Boolean).join(' · ') || email,
        link: cfg.notify.link || '#/marketing/course',
      },
    });
  } catch (err) {
    console.warn('[signup] notify failed', err.message, signupId);
  }
}
