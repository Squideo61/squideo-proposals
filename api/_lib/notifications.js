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

// Delivery channel for a notification: in-app bell only, email only, or both.
// Stored per role (roles.notification_channel_defaults) and overridable per
// user (user_notification_overrides.channel). Anything unset resolves to
// 'both', which is exactly the historical behaviour (bell + email together).
function normChannel(c) {
  return c === 'in_app' || c === 'email' ? c : 'both';
}

// Self-heal the schema for the per-notification delivery channel so the feature
// works before its migration lands (mirrors the ensure*Default helpers). All
// three statements are idempotent, so this is safe to run once per warm
// instance ahead of any read/write that touches the channel columns.
let channelSchemaReady = false;
export async function ensureNotificationChannelColumns() {
  if (channelSchemaReady) return;
  try {
    await sql`ALTER TABLE user_notification_overrides ADD COLUMN IF NOT EXISTS channel TEXT`;
    // A channel-only override (keep enabled at the role default, just change
    // delivery) needs enabled to be nullable.
    await sql`ALTER TABLE user_notification_overrides ALTER COLUMN enabled DROP NOT NULL`;
    await sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS notification_channel_defaults JSONB NOT NULL DEFAULT '{}'::jsonb`;
    channelSchemaReady = true;
  } catch (err) {
    console.warn('[notifications] ensureNotificationChannelColumns failed', err.message);
  }
}

// Self-heal for the in-app coalescing columns
// (db/migrations/20260820_in_app_notification_coalesce.sql). Idempotent, and a
// failure only costs coalescing — never the notification itself.
let coalesceSchemaReady = false;
export async function ensureInAppCoalesceColumns() {
  if (coalesceSchemaReady) return;
  try {
    await sql`ALTER TABLE in_app_notifications ADD COLUMN IF NOT EXISTS coalesce_group TEXT`;
    await sql`ALTER TABLE in_app_notifications ADD COLUMN IF NOT EXISTS coalesce_count INTEGER NOT NULL DEFAULT 1`;
    await sql`CREATE INDEX IF NOT EXISTS in_app_notif_coalesce_idx
                ON in_app_notifications (user_email, coalesce_group, created_at DESC)
                WHERE read_at IS NULL AND coalesce_group IS NOT NULL`;
    coalesceSchemaReady = true;
  } catch (err) {
    console.warn('[notifications] ensureInAppCoalesceColumns failed', err.message);
  }
}

// Resolve recipients for a notification key.
//   opts.ownerEmail      — required for audience:'owner', ignored otherwise
//   opts.assigneeEmails  — required for audience:'assignee'
//   opts.excludeEmails   — for broadcast, drop these from the result (used
//                          when one of them already got their own copy)
//
// Returns deduplicated, lowercased email strings. Empty array means nobody
// is subscribed — caller should still consider env-var fallbacks if any.
export async function resolveRecipients(key, opts = {}) {
  return (await resolveRecipientsDetailed(key, opts)).map(r => r.email);
}

// Same resolution as resolveRecipients, but each entry carries the recipient's
// effective delivery channel ({ email, channel }). sendNotification uses this to
// route the in-app write and the email independently per person.
export async function resolveRecipientsDetailed(key, opts = {}) {
  // The channel columns/queries are new. If they're somehow missing (migration
  // not applied AND the self-heal DDL failed), never break notifications — fall
  // back to the original enabled-only resolution and deliver via 'both'.
  try {
    await ensureNotificationChannelColumns();
    return await _resolveWithChannel(key, opts);
  } catch (err) {
    console.warn('[notifications] channel resolve failed; delivering via both', err.message);
    const emails = await _resolveLegacy(key, opts);
    return emails.map((email) => ({ email, channel: 'both' }));
  }
}

async function _resolveWithChannel(key, opts = {}) {
  const meta = NOTIFICATIONS_BY_KEY[key];
  if (!meta) {
    console.warn('[notifications] unknown key', key);
    return [];
  }
  const exclude = new Set((opts.excludeEmails || []).filter(Boolean).map(e => e.toLowerCase()));

  if (meta.audience === 'owner') {
    const email = (opts.ownerEmail || '').toLowerCase();
    if (!email || exclude.has(email)) return [];
    const rows = await sql`
      SELECT COALESCE(o.enabled, (r.notification_defaults->>${key})::boolean, false) AS enabled,
             COALESCE(o.channel, r.notification_channel_defaults->>${key}, 'both') AS channel
        FROM users u
        LEFT JOIN roles r ON r.id = u.role
        LEFT JOIN user_notification_overrides o
               ON o.user_email = u.email AND o.notification_key = ${key}
       WHERE u.email = ${email}
       LIMIT 1`;
    if (!rows[0] || !rows[0].enabled) return [];
    return [{ email, channel: normChannel(rows[0].channel) }];
  }

  if (meta.audience === 'assignee') {
    const emails = (opts.assigneeEmails || [])
      .filter(Boolean)
      .map(e => e.toLowerCase())
      .filter(e => !exclude.has(e));
    if (emails.length === 0) return [];
    const out = [];
    const seen = new Set();
    for (const e of emails) {
      if (seen.has(e)) continue;
      seen.add(e);
      // eslint-disable-next-line no-await-in-loop
      const rows = await sql`
        SELECT COALESCE(o.enabled, (r.notification_defaults->>${key})::boolean, false) AS enabled,
               COALESCE(o.channel, r.notification_channel_defaults->>${key}, 'both') AS channel
          FROM users u
          LEFT JOIN roles r ON r.id = u.role
          LEFT JOIN user_notification_overrides o
                 ON o.user_email = u.email AND o.notification_key = ${key}
         WHERE u.email = ${e}
         LIMIT 1`;
      if (rows[0] && rows[0].enabled) out.push({ email: e, channel: normChannel(rows[0].channel) });
    }
    return out;
  }

  // broadcast: every user where role default OR override resolves to true —
  // EXCEPT freelancers. Broadcasts are team-wide announcements (proposals,
  // payments, leads, good-to-go, leave, schedule clashes); a freelancer is an
  // external contractor who only ever hears about their own assigned work
  // (the owner/assignee audiences), never team broadcasts.
  const rows = await sql`
    SELECT u.email,
           COALESCE(o.enabled, (r.notification_defaults->>${key})::boolean, false) AS enabled,
           COALESCE(o.channel, r.notification_channel_defaults->>${key}, 'both') AS channel
      FROM users u
      LEFT JOIN roles r ON r.id = u.role
      LEFT JOIN user_notification_overrides o
             ON o.user_email = u.email AND o.notification_key = ${key}
     WHERE u.role IS DISTINCT FROM 'freelancer'
  `;
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row.enabled) continue;
    const e = String(row.email).toLowerCase();
    if (exclude.has(e) || seen.has(e)) continue;
    seen.add(e);
    out.push({ email: e, channel: normChannel(row.channel) });
  }
  return out;
}

// Original enabled-only resolution (no channel columns). Used as the safety-net
// fallback so a missing channel column can never stop notifications going out.
async function _resolveLegacy(key, opts = {}) {
  const meta = NOTIFICATIONS_BY_KEY[key];
  if (!meta) return [];
  const exclude = new Set((opts.excludeEmails || []).filter(Boolean).map(e => e.toLowerCase()));

  if (meta.audience === 'owner') {
    const email = (opts.ownerEmail || '').toLowerCase();
    if (!email || exclude.has(email)) return [];
    return (await isEnabledForUser(email, key)) ? [email] : [];
  }
  if (meta.audience === 'assignee') {
    const emails = (opts.assigneeEmails || []).filter(Boolean).map(e => e.toLowerCase()).filter(e => !exclude.has(e));
    if (emails.length === 0) return [];
    const filtered = [];
    for (const e of emails) {
      // eslint-disable-next-line no-await-in-loop
      if (await isEnabledForUser(e, key)) filtered.push(e);
    }
    return Array.from(new Set(filtered));
  }
  const rows = await sql`
    SELECT u.email, COALESCE(o.enabled, (r.notification_defaults->>${key})::boolean, false) AS enabled
      FROM users u
      LEFT JOIN roles r ON r.id = u.role
      LEFT JOIN user_notification_overrides o ON o.user_email = u.email AND o.notification_key = ${key}
     WHERE u.role IS DISTINCT FROM 'freelancer'`;
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

// Self-heal the role default for marketing.harvest_done.
//
// Defaults ON for every role, which is the exception rather than the rule here
// — and deliberate. This one only ever fires in response to something you
// started yourself, minutes earlier, and it is the ONLY way of finding out that
// a background job you kicked off has finished. Defaulting it off (what an
// absent key resolves to) would mean the sweep silently never told anyone,
// which is indistinguishable from it having hung.
let harvestDefaultReady = false;
export async function ensureHarvestNotificationDefault() {
  if (harvestDefaultReady) return;
  try {
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{marketing.harvest_done}', 'true'::jsonb, true)
      WHERE NOT (notification_defaults ? 'marketing.harvest_done')`;
    harvestDefaultReady = true;
  } catch (err) {
    console.warn('[notifications] ensureHarvestNotificationDefault failed', err.message);
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

// Self-heal the role default + delivery channel for po.received ("a teammate
// recorded a client PO"). ON for Admin / Director / Project-Production Manager
// (role 'member') — the people who chase POs and invoice against them; the
// producer/copywriter roles don't need it. Delivered IN-APP ONLY by default
// (bell + desktop push, no email): a PO lands often enough that an email each
// time would be noise. Anyone can switch themselves to email/both in Account
// settings. Guarded to run once per warm instance.
let poReceivedDefaultReady = false;
export async function ensurePoReceivedNotificationDefault() {
  if (poReceivedDefaultReady) return;
  try {
    await ensureNotificationChannelColumns();
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{po.received}', 'true'::jsonb, true)
      WHERE id IN ('admin', 'director', 'member') AND NOT (notification_defaults ? 'po.received')`;
    await sql`UPDATE roles SET notification_channel_defaults = jsonb_set(
      notification_channel_defaults, '{po.received}', '"in_app"'::jsonb, true)
      WHERE NOT (notification_channel_defaults ? 'po.received')`;
    poReceivedDefaultReady = true;
  } catch (err) {
    console.warn('[notifications] ensurePoReceivedNotificationDefault failed', err.message);
  }
}

// Self-heal role defaults for the customer-portal keys so portal alerts work
// before a seed/migration lands. Each key inherits from the closest existing
// staff alert: member_joined ← user.invite_accepted, doc_uploaded ←
// project.good_to_go, extra_accepted ← extra.added (admin/director ON),
// po_provided + partner_interest ← quote_request.new; voiceover_selected ←
// project.good_to_go (bell-only). Guarded to run at most once per warm instance.
let portalDefaultsReady = false;
// Video-guide signups. On for whoever already receives new quote requests —
// it's the same job (a stranger just raised their hand), so the same people
// should hear about it without anyone configuring a second list.
//
// Bell-only by default, which is what raises a desktop/phone push. A lead
// magnet is meant to be high volume, and an inbox copy of each one is read for
// a week and filtered forever after.
let courseSignupDefaultReady = false;
export async function ensureCourseSignupNotificationDefault() {
  if (courseSignupDefaultReady) return;
  try {
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{course.signup}',
      COALESCE(notification_defaults->'quote_request.new', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'course.signup')`;
    await sql`UPDATE roles SET notification_channel_defaults = jsonb_set(
      notification_channel_defaults, '{course.signup}', '"in_app"'::jsonb, true)
      WHERE NOT (notification_channel_defaults ? 'course.signup')`;
    courseSignupDefaultReady = true;
  } catch (err) {
    console.warn('[notifications] ensureCourseSignupNotificationDefault failed', err.message);
  }
}

// "All the client's comments on this draft are done" is an internal milestone,
// not something anyone has to act on from their inbox — the bell (and the
// desktop push it raises) is the right surface, and an email per draft on every
// project is noise. Bell-only by DEFAULT, so anyone who does want the email can
// switch it back on in their own notification preferences; an explicit choice
// already on record is left alone. Guarded to run once per warm instance.
let revisionCompleteDefaultReady = false;
export async function ensureRevisionCompleteNotificationDefault() {
  if (revisionCompleteDefaultReady) return;
  try {
    await ensureNotificationChannelColumns();
    await sql`UPDATE roles SET notification_channel_defaults = jsonb_set(
      notification_channel_defaults, '{revision.draft_completed}', '"in_app"'::jsonb, true)
      WHERE NOT (notification_channel_defaults ? 'revision.draft_completed')`;
    await sql`UPDATE roles SET notification_channel_defaults = jsonb_set(
      notification_channel_defaults, '{storyboard.draft_completed}', '"in_app"'::jsonb, true)
      WHERE NOT (notification_channel_defaults ? 'storyboard.draft_completed')`;
    revisionCompleteDefaultReady = true;
  } catch (err) {
    console.warn('[notifications] ensureRevisionCompleteNotificationDefault failed', err.message);
  }
}

// A prospect finishing a stage of the sample project is the same kind of event
// as a course signup — a stranger raising their hand — so it inherits the same
// audience and the same bell-only channel. It's a much warmer signal than a
// signup (they've just used the tools), but a noisier default would be the
// fastest way to get the whole Leads group muted.
let sampleProjectDefaultReady = false;
export async function ensureSampleProjectNotificationDefault() {
  if (sampleProjectDefaultReady) return;
  try {
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.sample_project}',
      COALESCE(notification_defaults->'course.signup',
               notification_defaults->'quote_request.new', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.sample_project')`;
    await sql`UPDATE roles SET notification_channel_defaults = jsonb_set(
      notification_channel_defaults, '{portal.sample_project}', '"in_app"'::jsonb, true)
      WHERE NOT (notification_channel_defaults ? 'portal.sample_project')`;
    sampleProjectDefaultReady = true;
  } catch (err) {
    console.warn('[notifications] ensureSampleProjectNotificationDefault failed', err.message);
  }
}

export async function ensurePortalNotificationDefaults() {
  if (portalDefaultsReady) return;
  try {
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.member_joined}',
      COALESCE(notification_defaults->'user.invite_accepted', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.member_joined')`;
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.doc_uploaded}',
      COALESCE(notification_defaults->'project.good_to_go', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.doc_uploaded')`;
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.extra_accepted}', 'true'::jsonb, true)
      WHERE id IN ('admin', 'director') AND NOT (notification_defaults ? 'portal.extra_accepted')`;
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.po_provided}',
      COALESCE(notification_defaults->'quote_request.new', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.po_provided')`;
    // A finalised brief is a production signal, not a sales one — it lands
    // with whoever already hears that a project is good to go.
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.brief_finalised}',
      COALESCE(notification_defaults->'project.good_to_go', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.brief_finalised')`;
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.partner_interest}',
      COALESCE(notification_defaults->'quote_request.new', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.partner_interest')`;
    // Video-credit commerce (invoice request + card purchase). Sales events —
    // inherit whoever already receives new quote requests.
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.video_credit_request}',
      COALESCE(notification_defaults->'quote_request.new', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.video_credit_request')`;
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.video_credit_purchase}',
      COALESCE(notification_defaults->'quote_request.new', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.video_credit_purchase')`;
    // Script / visual direction sent by the client (or "please write it for
    // us") — a production milestone the producer acts on, so it inherits
    // whoever already gets doc_uploaded / project.good_to_go.
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.script_uploaded}',
      COALESCE(notification_defaults->'portal.doc_uploaded',
               notification_defaults->'project.good_to_go', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.script_uploaded')`;
    // Voiceover pick is a production milestone — inherit project.good_to_go like
    // doc_uploaded, and default to the in-app bell only (it can be frequent).
    await sql`UPDATE roles SET notification_defaults = jsonb_set(
      notification_defaults, '{portal.voiceover_selected}',
      COALESCE(notification_defaults->'project.good_to_go', 'false'::jsonb), true)
      WHERE NOT (notification_defaults ? 'portal.voiceover_selected')`;
    await sql`UPDATE roles SET notification_channel_defaults = jsonb_set(
      notification_channel_defaults, '{portal.voiceover_selected}', '"in_app"'::jsonb, true)
      WHERE NOT (notification_channel_defaults ? 'portal.voiceover_selected')`;
    portalDefaultsReady = true;
  } catch (err) {
    console.warn('[notifications] ensurePortalNotificationDefaults failed', err.message);
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
  await ensureNotificationChannelColumns();
  const rows = await sql`
    SELECT u.role,
           r.notification_defaults,
           r.notification_channel_defaults,
           COALESCE(json_object_agg(o.notification_key, o.enabled) FILTER (WHERE o.notification_key IS NOT NULL), '{}'::json) AS overrides,
           COALESCE(json_object_agg(o.notification_key, o.channel) FILTER (WHERE o.notification_key IS NOT NULL AND o.channel IS NOT NULL), '{}'::json) AS channel_overrides
      FROM users u
      LEFT JOIN roles r ON r.id = u.role
      LEFT JOIN user_notification_overrides o ON o.user_email = u.email
     WHERE u.email = ${email}
     GROUP BY u.role, r.notification_defaults, r.notification_channel_defaults
     LIMIT 1
  `;
  const row = rows[0];
  const defaults = row?.notification_defaults || {};
  const channelDefaults = row?.notification_channel_defaults || {};
  const overrides = row?.overrides || {};
  const channelOverrides = row?.channel_overrides || {};
  const out = {};
  for (const n of NOTIFICATIONS) {
    // enabled: a NULL override value means "channel-only override" → fall back
    // to the role default for enabled.
    const hasEnabledOverride = Object.prototype.hasOwnProperty.call(overrides, n.key) && overrides[n.key] !== null;
    const enabled = hasEnabledOverride
      ? !!overrides[n.key]
      : (Object.prototype.hasOwnProperty.call(defaults, n.key) ? !!defaults[n.key] : false);
    const roleChannel = normChannel(channelDefaults[n.key]);
    const hasChannelOverride = Object.prototype.hasOwnProperty.call(channelOverrides, n.key) && channelOverrides[n.key] != null;
    out[n.key] = {
      enabled,
      source: hasEnabledOverride ? 'override' : 'role',
      channel: hasChannelOverride ? normChannel(channelOverrides[n.key]) : roleChannel,
      channelSource: hasChannelOverride ? 'override' : 'role',
      roleChannel,
    };
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
  const detailed = await resolveRecipientsDetailed(key, { ownerEmail, assigneeEmails, excludeEmails });
  const recipients = detailed.map(r => r.email);
  // Split by each recipient's chosen delivery channel. 'both' (the default)
  // lands in both lists, exactly reproducing the old bell-and-email behaviour.
  const inAppRecipients = detailed.filter(r => r.channel === 'in_app' || r.channel === 'both').map(r => r.email);
  const emailRecipients = detailed.filter(r => r.channel === 'email' || r.channel === 'both').map(r => r.email);

  // Persist an in-app feed entry for every recipient whose channel includes the
  // bell. These are always real workspace users (the resolver only returns
  // users), so the FK holds. `extraRecipients` (env-var fallbacks that may not
  // be users) are intentionally excluded — they only get email.
  // Best-effort: an in-app write must never stop the email going out.
  if (inAppRecipients.length) {
    await persistInApp(key, inAppRecipients, { subject, text, inApp });
  }

  // In-app-only alerts (e.g. ticking a pending payment paid) skip email entirely
  // so frequent manual actions don't spam inboxes — the bell is enough.
  if (inAppOnly) return { sent: 0, recipients, inApp: inAppRecipients.length };

  const extras = (extraRecipients || [])
    .filter(Boolean)
    .map(e => e.toLowerCase())
    .filter(e => !(excludeEmails || []).map(x => (x || '').toLowerCase()).includes(e));
  const to = Array.from(new Set([...emailRecipients, ...extras]));
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
// `inApp.coalesce` rolls related events into ONE row instead of a stack of
// near-identical ones (a client uploading eight brand files shouldn't cost eight
// notifications). Shape:
//   { group, summaryTitle, summaryBody?, windowMinutes? }
// The first event lands normally with the caller's own title; each later one in
// the same group, while still unread and inside the window, bumps a counter and
// rewrites the row to `summaryTitle` — a template whose `{n}` is replaced with
// the running count. The row's created_at is refreshed so it stays at the top of
// the feed, and the push tag is per-group so the desktop alert REPLACES its
// predecessor rather than stacking.
//
// The match is on the GROUP alone, not the notification key, so a later stage of
// the same story can supersede an earlier one: "invoice requested" becomes
// "invoice issued" in place when the client completes billing, while a client
// who abandons at the billing form leaves the "requested" alert standing. The
// row adopts the newer key so it still files under the right bell.
export async function persistInApp(key, recipients, { subject, text, inApp }) {
  const title = String(inApp?.title || subject || 'Notification').slice(0, 200);
  const body = inApp?.body != null
    ? String(inApp.body).slice(0, 500)
    : (text ? (String(text).replace(/\s*https?:\/\/\S+\s*$/i, '').trim().slice(0, 500) || null) : null);
  const link = inApp?.link || null;
  const tagOverride = inApp?.tag || null;
  const coalesce = inApp?.coalesce?.group ? inApp.coalesce : null;
  const group = coalesce ? String(coalesce.group).slice(0, 200) : null;
  // Capped at 30 days: a supersede can legitimately span days (a client returns
  // to finish their billing details), while an unread row older than that is
  // stale enough that a fresh alert is the honest thing to show.
  const windowMinutes = Math.min(43200, Math.max(1, Number(coalesce?.windowMinutes) || 120));
  const summaryTitle = coalesce ? String(coalesce.summaryTitle || title).slice(0, 200) : null;
  const summaryBody = coalesce?.summaryBody != null ? String(coalesce.summaryBody).slice(0, 500) : null;
  if (coalesce) await ensureInAppCoalesceColumns();

  const pushes = [];
  for (const email of recipients) {
    try {
      let id = null;
      let outTitle = title;
      let outBody = body;

      if (coalesce) {
        // Fold into the newest unread row of this group. The count is resolved
        // inside the statement so concurrent uploads can't race to the same
        // number. Falls through to a fresh insert when there's nothing to fold.
        // eslint-disable-next-line no-await-in-loop
        const rolled = await sql`
          UPDATE in_app_notifications
             SET coalesce_count = coalesce_count + 1,
                 created_at = NOW(),
                 notification_key = ${key},
                 title = replace(${summaryTitle}::text, '{n}', (coalesce_count + 1)::text),
                 body = COALESCE(${summaryBody}::text, body)
           WHERE id = (
             SELECT id FROM in_app_notifications
              WHERE user_email = ${email}
                AND coalesce_group = ${group}
                AND read_at IS NULL
                AND created_at > NOW() - make_interval(mins => ${windowMinutes}::int)
              ORDER BY created_at DESC
              LIMIT 1)
           RETURNING id, title, body`;
        if (rolled.length) {
          id = rolled[0].id;
          outTitle = rolled[0].title;
          outBody = rolled[0].body;
        }
      }

      if (id == null) {
        // Two variants so a caller that doesn't coalesce never touches the
        // coalesce columns — they're self-healed only on the coalescing path,
        // and an ordinary notification must not depend on that having run.
        // eslint-disable-next-line no-await-in-loop
        const rows = group
          ? await sql`INSERT INTO in_app_notifications (user_email, notification_key, title, body, link, coalesce_group)
                      VALUES (${email}, ${key}, ${title}, ${body}, ${link}, ${group})
                      RETURNING id`
          : await sql`INSERT INTO in_app_notifications (user_email, notification_key, title, body, link)
                      VALUES (${email}, ${key}, ${title}, ${body}, ${link})
                      RETURNING id`;
        id = rows[0]?.id;
      }
      const tag = tagOverride
        || (group ? `coalesce-${group}` : (id != null ? `notif-${id}` : undefined));
      pushes.push(sendWebPush([email], { title: outTitle, body: outBody, link, tag }));
    } catch (err) {
      console.warn('[notifications] in-app persist failed', err.message);
    }
  }
  // Best-effort fan-out; sendWebPush swallows its own errors. Awaited so the
  // sends complete before a serverless function freezes.
  if (pushes.length) { try { await Promise.allSettled(pushes); } catch { /* ignore */ } }
}
