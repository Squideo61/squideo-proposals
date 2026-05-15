// Recipient resolver + sendNotification helper.
//
// Every internal staff email goes through `sendNotification(key, opts)`. The
// helper looks up who's subscribed (combining role defaults with per-user
// overrides) and dispatches via `sendMail`. Client-facing emails (signed
// thanks, paid thanks, invite, 2FA) bypass this entirely and call `sendMail`
// directly — they're never optional.
//
// Audience modes (declared per notification in ./notificationsCatalog.js):
//   - broadcast : send to every user who has the pref enabled
//   - owner     : send to opts.ownerEmail, but only if THEY have it enabled
//   - assignee  : send to opts.assigneeEmails, filtered to those who have it
//
// Role defaults live in roles.notification_defaults (jsonb). Per-user
// overrides in user_notification_overrides take precedence. If neither exists
// for a (user, key) pair, the notification is treated as OFF — which is why
// the seeded role defaults explicitly list every key.

import sql from './db.js';
import { sendMail } from './email.js';
import { NOTIFICATIONS, isValidNotificationKey, getNotificationMeta } from './notificationsCatalog.js';

export { NOTIFICATIONS, isValidNotificationKey, getNotificationMeta };

const NOTIFICATIONS_BY_KEY = Object.fromEntries(NOTIFICATIONS.map(n => [n.key, n]));

// Resolve recipients for a notification key.
//   opts.ownerEmail      — required for audience:'owner', ignored otherwise
//   opts.assigneeEmails  — required for audience:'assignee'
//   opts.excludeEmails   — for broadcast, drop these from the result (used
//                          when one of them already got their own copy)
//
// Returns deduplicated, lowercased email strings. Empty array means nobody
// is subscribed — caller should still consider env-var fallbacks if any.
export async function resolveRecipients(key, opts = {}) {
  const meta = NOTIFICATIONS_BY_KEY[key];
  if (!meta) {
    console.warn('[notifications] unknown key', key);
    return [];
  }
  const exclude = new Set((opts.excludeEmails || []).filter(Boolean).map(e => e.toLowerCase()));

  if (meta.audience === 'owner') {
    const email = (opts.ownerEmail || '').toLowerCase();
    if (!email || exclude.has(email)) return [];
    const enabled = await isEnabledForUser(email, key);
    return enabled ? [email] : [];
  }

  if (meta.audience === 'assignee') {
    const emails = (opts.assigneeEmails || [])
      .filter(Boolean)
      .map(e => e.toLowerCase())
      .filter(e => !exclude.has(e));
    if (emails.length === 0) return [];
    const filtered = [];
    for (const e of emails) {
      // eslint-disable-next-line no-await-in-loop
      if (await isEnabledForUser(e, key)) filtered.push(e);
    }
    return Array.from(new Set(filtered));
  }

  // broadcast: every user where role default OR override resolves to true.
  const rows = await sql`
    SELECT u.email,
           COALESCE(o.enabled, (r.notification_defaults->>${key})::boolean, false) AS enabled
      FROM users u
      LEFT JOIN roles r ON r.id = u.role
      LEFT JOIN user_notification_overrides o
             ON o.user_email = u.email AND o.notification_key = ${key}
  `;
  const out = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const e = String(row.email).toLowerCase();
    if (exclude.has(e)) continue;
    out.push(e);
  }
  return Array.from(new Set(out));
}

// Read the effective state of a single (user, key) — role default merged with
// per-user override. Returns boolean. Unknown users → false.
export async function isEnabledForUser(email, key) {
  const rows = await sql`
    SELECT COALESCE(o.enabled, (r.notification_defaults->>${key})::boolean, false) AS enabled
      FROM users u
      LEFT JOIN roles r ON r.id = u.role
      LEFT JOIN user_notification_overrides o
             ON o.user_email = u.email AND o.notification_key = ${key}
     WHERE u.email = ${email}
     LIMIT 1
  `;
  return !!(rows[0] && rows[0].enabled);
}

// Read effective prefs for one user across ALL notification keys. Used by the
// UI to render the AccountSettings notification editor without a query per
// row. Returns { [key]: { enabled: bool, source: 'override' | 'role' } }.
export async function getEffectivePrefs(email) {
  const rows = await sql`
    SELECT u.role,
           r.notification_defaults,
           COALESCE(json_object_agg(o.notification_key, o.enabled) FILTER (WHERE o.notification_key IS NOT NULL), '{}'::json) AS overrides
      FROM users u
      LEFT JOIN roles r ON r.id = u.role
      LEFT JOIN user_notification_overrides o ON o.user_email = u.email
     WHERE u.email = ${email}
     GROUP BY u.role, r.notification_defaults
     LIMIT 1
  `;
  const row = rows[0];
  const defaults = row?.notification_defaults || {};
  const overrides = row?.overrides || {};
  const out = {};
  for (const n of NOTIFICATIONS) {
    if (Object.prototype.hasOwnProperty.call(overrides, n.key)) {
      out[n.key] = { enabled: !!overrides[n.key], source: 'override' };
    } else if (Object.prototype.hasOwnProperty.call(defaults, n.key)) {
      out[n.key] = { enabled: !!defaults[n.key], source: 'role' };
    } else {
      out[n.key] = { enabled: false, source: 'role' };
    }
  }
  return out;
}

// Send a notification. Resolves recipients, then fires one email (per-user
// emails get the same body — fine here because none of our staff emails
// include personalised data beyond CTA links).
//
// `extraRecipients`: emails always included regardless of prefs. Use sparingly
// — currently only used for the QUOTE_REQUEST_NOTIFY_TO env fallback so a
// freshly-deployed workspace with no subscribers still gets the alert.
export async function sendNotification(key, {
  subject,
  html,
  text,
  ownerEmail = null,
  assigneeEmails = null,
  excludeEmails = null,
  extraRecipients = null,
  throwOnError = false,
} = {}) {
  const recipients = await resolveRecipients(key, { ownerEmail, assigneeEmails, excludeEmails });
  const extras = (extraRecipients || [])
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .filter(e => !(excludeEmails || []).map(x => (x || '').toLowerCase()).includes(e));
  const to = Array.from(new Set([...recipients, ...extras]));
  if (to.length === 0) return { sent: 0, recipients: [] };
  await sendMail({ to, subject, html, text, throwOnError });
  return { sent: to.length, recipients: to };
}
