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
import { sendWebPush } from './push.js';
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

// Resolve the staff "team" for a deal: its assignees plus the deal owner.
// Used to target revision/storyboard notifications at everyone working a deal.
// Falls back to `fallbackEmail` (e.g. the project creator) when the project
// isn't linked to a deal, so an alert is never silently dropped. Returns
// deduplicated, lowercased emails.
export async function resolveDealTeamEmails(dealId, fallbackEmail = null) {
  const out = new Set();
  if (dealId) {
    const rows = await sql`
      SELECT user_email AS email FROM deal_assignees WHERE deal_id = ${dealId}
      UNION
      SELECT owner_email AS email FROM deals WHERE id = ${dealId} AND owner_email IS NOT NULL
    `;
    for (const r of rows) if (r.email) out.add(String(r.email).toLowerCase());
  }
  if (out.size === 0 && fallbackEmail) out.add(String(fallbackEmail).toLowerCase());
  return Array.from(out);
}

// Self-heal role defaults for the tracking-bell keys so the feature works
// before its migration is applied. Defaults each ON wherever the role already
// gets proposal.first_view (i.e. sales-facing roles). Guarded to run at most
// once per warm instance — callers fire it best-effort before notifying.
let trackingDefaultsReady = false;
export async function ensureTrackingNotificationDefaults() {
  if (trackingDefaultsReady) return;
  try {
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{tracking.email_opened}',
      COALESCE(notification_defaults->'proposal.first_view', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'tracking.email_opened')`;
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{tracking.proposal_opened}',
      COALESCE(notification_defaults->'proposal.first_view', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'tracking.proposal_opened')`;
    trackingDefaultsReady = true;
  } catch (err) {
    console.warn('[notifications] ensureTrackingNotificationDefaults failed', err.message);
  }
}

// Self-heal the role default for the intro_call.booked key so the booking
// notification works before its migration/seed lands. Defaults each role's
// value to whatever it gets for revision.feedback_submitted (the closest
// project-team alert), else off. Guarded to run once per warm instance.
let introCallDefaultReady = false;
export async function ensureIntroCallNotificationDefault() {
  if (introCallDefaultReady) return;
  try {
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{intro_call.booked}',
      COALESCE(notification_defaults->'revision.feedback_submitted', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'intro_call.booked')`;
    introCallDefaultReady = true;
  } catch (err) {
    console.warn('[notifications] ensureIntroCallNotificationDefault failed', err.message);
  }
}

// Self-heal the role default for comment.mention so @-mentions notify before a
// seed/migration lands. Defaults ON for every role — a mention is a direct,
// deliberate ping, so it should reach the person unless they explicitly mute it.
// Guarded to run once per warm instance.
let commentMentionDefaultReady = false;
export async function ensureCommentMentionNotificationDefault() {
  if (commentMentionDefaultReady) return;
  try {
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{comment.mention}', 'true'::jsonb, true)
      WHERE NOT (notification_defaults ? 'comment.mention')`;
    commentMentionDefaultReady = true;
  } catch (err) {
    console.warn('[notifications] ensureCommentMentionNotificationDefault failed', err.message);
  }
}

// Self-heal the role default for quote_request.qualified so the "a teammate
// qualified a lead" alert works before its seed/migration lands. Defaults each
// role to whatever it gets for quote_request.new (the same sales/finance roles
// that watch incoming leads). Guarded to run once per warm instance.
let quoteQualifiedDefaultReady = false;
export async function ensureQuoteQualifiedNotificationDefault() {
  if (quoteQualifiedDefaultReady) return;
  try {
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{quote_request.qualified}',
      COALESCE(notification_defaults->'quote_request.new', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'quote_request.qualified')`;
    quoteQualifiedDefaultReady = true;
  } catch (err) {
    console.warn('[notifications] ensureQuoteQualifiedNotificationDefault failed', err.message);
  }
}

// Self-heal the role default for extra.added so the "extra charge added" alert
// works before its seed/migration lands. Default ON for Admin + Director only —
// they own billing oversight and need to know when production logs an ad-hoc
// charge; the production team that adds them doesn't need pinging. Guarded to
// run once per warm instance.
let extraAddedDefaultReady = false;
export async function ensureExtraAddedNotificationDefault() {
  if (extraAddedDefaultReady) return;
  try {
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{extra.added}', 'true'::jsonb, true)
      WHERE id IN ('admin', 'director') AND NOT (notification_defaults ? 'extra.added')`;
    extraAddedDefaultReady = true;
  } catch (err) {
    console.warn('[notifications] ensureExtraAddedNotificationDefault failed', err.message);
  }
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
  inApp = null,
  inAppOnly = false,
} = {}) {
  const recipients = await resolveRecipients(key, { ownerEmail, assigneeEmails, excludeEmails });

  // Persist an in-app feed entry for every pref-resolved recipient so the bell
  // mirrors the email. These are always real workspace users (the resolver
  // only returns users), so the FK holds. `extraRecipients` (env-var fallbacks
  // that may not be users) are intentionally excluded — they only get email.
  // Best-effort: an in-app write must never stop the email going out.
  if (recipients.length) {
    await persistInApp(key, recipients, { subject, text, inApp });
  }

  // In-app-only alerts (e.g. ticking a pending payment paid) skip email entirely
  // so frequent manual actions don't spam inboxes — the bell is enough.
  if (inAppOnly) return { sent: 0, recipients, inApp: recipients.length };

  const extras = (extraRecipients || [])
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .filter(e => !(excludeEmails || []).map(x => (x || '').toLowerCase()).includes(e));
  const to = Array.from(new Set([...recipients, ...extras]));
  if (to.length === 0) return { sent: 0, recipients: [] };
  await sendMail({ to, subject, html, text, throwOnError });
  return { sent: to.length, recipients: to };
}

// Write one in-app notification row per recipient. Title/body default from the
// email's subject/text; callers can override via `inApp`. `link` should be an
// in-app hash route (e.g. '#/admin/users') so the bell navigates without a
// full reload — distinct from the absolute APP_URL link used in the email.
//
// Each persisted row is also mirrored to the recipient's desktop via Web Push
// (Tier 2) — a no-op when push isn't provisioned or the user has no devices
// subscribed. The push tag defaults to `notif-<rowId>` so it matches the in-tab
// (Tier 1) dedupe tag for the same item; callers may override via inApp.tag.
export async function persistInApp(key, recipients, { subject, text, inApp }) {
  const title = String(inApp?.title || subject || 'Notification').slice(0, 200);
  const body = inApp?.body != null
    ? String(inApp.body).slice(0, 500)
    : (text ? (String(text).replace(/\s*https?:\/\/\S+\s*$/i, '').trim().slice(0, 500) || null) : null);
  const link = inApp?.link || null;
  const tagOverride = inApp?.tag || null;
  const pushes = [];
  for (const email of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows = await sql`INSERT INTO in_app_notifications (user_email, notification_key, title, body, link)
                VALUES (${email}, ${key}, ${title}, ${body}, ${link})
                RETURNING id`;
      const id = rows[0]?.id;
      const tag = tagOverride || (id != null ? `notif-${id}` : undefined);
      pushes.push(sendWebPush([email], { title, body, link, tag }));
    } catch (err) {
      console.warn('[notifications] in-app persist failed', err.message);
    }
  }
  // Best-effort fan-out; sendWebPush swallows its own errors. Awaited so the
  // sends complete before a serverless function freezes.
  if (pushes.length) { try { await Promise.allSettled(pushes); } catch { /* ignore */ } }
}
