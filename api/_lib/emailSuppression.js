// Global email suppression — the compliance backbone for marketing sends.
//
// Enforced inside sendMail() itself rather than at each call site. One choke
// point means no future campaign can forget, and "did that cron remember to
// check the unsubscribe list?" stops being a question anyone has to ask.
//
// SUPPRESSION NEVER BLOCKS TRANSACTIONAL EMAIL. See suppressedAmong() below —
// a non-marketing send returns early and never even runs the query.
//
// `scope` on a row records WHY someone is on the list, for reporting and for
// future bulk-send tooling. It does not widen what gets blocked:
//   'marketing'  — they asked to stop being sold to.
//   'all'        — hard bounce or spam complaint. Still only blocks marketing;
//                  it means "don't put this address in a campaign", not "cut
//                  this client off from their own project".
//
// Under UK PECR the unsubscribe has to be honoured across everything we send,
// not per-campaign. The existing quote-resume drip had its own per-session
// unsubscribe flag, which meant unsubscribing from one thing told us nothing
// about the next — the migration backfills those into here.

import crypto from 'node:crypto';
import sql from './db.js';

let ensured = null;
export function ensureSuppressionTable() {
  if (ensured) return ensured;
  ensured = (async () => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS email_suppressions (
          email      TEXT        PRIMARY KEY,
          scope      TEXT        NOT NULL DEFAULT 'marketing',
          reason     TEXT        NOT NULL,
          source     TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
    } catch (err) {
      console.warn('[suppression] ensure failed', err.message);
    }
  })();
  return ensured;
}

const norm = (e) => String(e || '').trim().toLowerCase();

// Returns the set of suppressed addresses among those given. One query rather
// than one per recipient — sendMail may be handing us a cc list.
//
// ═══ SUPPRESSION ONLY EVER APPLIES TO MARKETING ══════════════════════════════
// Nothing in this table can stop a transactional email. Not an unsubscribe, not
// a complaint, not a bounce.
//
// A suppression row means "stop selling to me". It must never stop:
//   · project notifications (a review is ready, a task is waiting on you)
//   · invoices and payment confirmations
//   · password resets and sign-in links
//   · anything a member of staff sends by hand
//
// Those are the service someone is paying for, and withholding one because of
// a marketing opt-out — or worse, because their mail server bounced once
// eighteen months ago — silently breaks a live project. The cost of the
// opposite mistake is an email that bounces again, which is free.
//
// (Staff-composed emails don't pass through here at all: they go out via the
// Gmail API in performGmailSend. The early return below means that stays true
// even if something reroutes them through sendMail one day.)
// ═════════════════════════════════════════════════════════════════════════════
export async function suppressedAmong(emails, scope = 'marketing') {
  if (scope !== 'marketing') return new Set();
  const list = [...new Set((emails || []).map(norm).filter(Boolean))];
  if (!list.length) return new Set();
  await ensureSuppressionTable();
  try {
    const rows = await sql`SELECT email FROM email_suppressions WHERE email = ANY(${list})`;
    return new Set(rows.map((r) => r.email));
  } catch (err) {
    // Fails CLOSED, but only for marketing: if we can't tell whether someone
    // opted out, not sending is the safe answer. Transactional already
    // returned above, so no invoice is ever at risk from a database blip.
    console.warn('[suppression] lookup failed', err.message);
    const blocked = new Set(list);
    // …but say WHY everyone came back blocked. Without this the caller cannot
    // tell "these people opted out" from "I couldn't find out", and a campaign
    // would permanently mark a whole batch as unsubscribed — recording a
    // decision those people never made — because the database blinked.
    blocked.degraded = true;
    return blocked;
  }
}

export async function isSuppressed(email, scope = 'marketing') {
  return (await suppressedAmong([email], scope)).has(norm(email));
}

export async function suppress({ email, scope = 'marketing', reason = 'unsubscribe', source = null }) {
  const e = norm(email);
  if (!e) return false;
  await ensureSuppressionTable();
  try {
    await sql`
      INSERT INTO email_suppressions (email, scope, reason, source)
      VALUES (${e}, ${scope}, ${reason}, ${source})
      ON CONFLICT (email) DO UPDATE SET
        -- 'all' outranks 'marketing': a bounce after an unsubscribe should
        -- widen the suppression, never narrow it back.
        scope  = CASE WHEN email_suppressions.scope = 'all' OR EXCLUDED.scope = 'all'
                      THEN 'all' ELSE EXCLUDED.scope END,
        reason = EXCLUDED.reason,
        source = COALESCE(EXCLUDED.source, email_suppressions.source)
    `;
    return true;
  } catch (err) {
    console.warn('[suppression] insert failed', err.message);
    return false;
  }
}

export async function unsuppress(email) {
  const e = norm(email);
  if (!e) return;
  await ensureSuppressionTable();
  try { await sql`DELETE FROM email_suppressions WHERE email = ${e}`; }
  catch (err) { console.warn('[suppression] delete failed', err.message); }
}

// ── Unsubscribe tokens ───────────────────────────────────────────────────────
// Stateless and HMAC-signed, so a link can be put in an email without first
// writing a row — and so a token can't be guessed or replayed for a different
// address. Keyed on JWT_SECRET, which every deployment already has.
function secret() {
  return process.env.JWT_SECRET || process.env.CRON_SECRET || 'squideo-unsubscribe';
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function unsubscribeToken(email, list = 'marketing') {
  const payload = b64u(JSON.stringify({ e: norm(email), l: list }));
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Returns { email, list } or null. Constant-time comparison so the signature
// can't be brute-forced a byte at a time.
export function readUnsubscribeToken(token) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { e, l } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return e ? { email: e, list: l || 'marketing' } : null;
  } catch {
    return null;
  }
}

export function unsubscribeUrlFor(email, list = 'marketing') {
  const base = (process.env.APP_URL || 'https://app.squideo.com').replace(/\/$/, '');
  return `${base}/api/email-prefs?action=unsubscribe&t=${encodeURIComponent(unsubscribeToken(email, list))}`;
}

// RFC 8058 one-click plus the mailto fallback. Gmail and Outlook surface their
// own "unsubscribe" affordance when these are present, which is both better
// for the recipient and materially better for deliverability — people who can
// unsubscribe easily don't press "spam" instead.
export function listUnsubscribeHeaders(email, list = 'marketing') {
  return {
    'List-Unsubscribe': `<mailto:unsubscribe@squideo.co.uk>, <${unsubscribeUrlFor(email, list)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
