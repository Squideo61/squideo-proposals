// The hourly "someone changed the brief" digest.
//
// The bell is immediate; email is not. A brief being worked through by three
// people produces a change every few seconds, and a mail per change would
// train everyone to filter the address that also carries their sign-off
// requests. So: changes settle for QUIET_MINUTES, then whoever DIDN'T make
// them gets one email describing the lot.
//
// Every event carries digested_at, so the same change can never be mailed
// twice even if a run overlaps or retries.

import sql from '../db.js';
import { sendMail } from '../email.js';
import { PORTAL_URL, briefDigestHtml } from '../portal/emails.js';
import { resolvePortalRecipients } from '../portal/notifications.js';
import { ensureClientBriefs } from './db.js';
import { serialiseEvent } from './collab.js';

// How long a change has to sit still before it's mailed. Long enough that a
// working session lands as one email, short enough that a colleague who checks
// after lunch hears about the morning's work.
const QUIET_MINUTES = 20;
// Belt and braces against a backlog: never mail about changes older than this,
// just mark them digested. A day-old "someone edited a question" helps nobody.
const STALE_HOURS = 24;
const MAX_BRIEFS_PER_RUN = 25;

const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

// "Priya", "Priya and Tom", "Priya, Tom and 2 others".
export function joinNames(names) {
  const list = [...new Set(names.filter(Boolean))];
  if (!list.length) return 'Someone';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list[0]}, ${list[1]} and ${list.length - 2} other${list.length - 2 === 1 ? '' : 's'}`;
}

// Subject + body for one brief's batch. Pure, so the wording is testable
// without a database or a mail server.
export function buildDigest({ briefTitle, dealTitle, events, url }) {
  const who = joinNames(events.map((e) => e.actorName));
  const n = events.length;
  const finalised = events.some((e) => e.eventKey === 'brief.finalised');
  const name = briefTitle || 'your video brief';

  const subject = finalised
    ? `${who} finalised ${name}`
    : `${who} made ${n} change${n === 1 ? '' : 's'} to ${name}`;

  // Newest first, capped: the point is "go and look", not a full transcript.
  const shown = events.slice(0, 12);
  const items = shown.map((e) => `
    <li style="margin:0 0 9px;">
      <span style="color:#0F2A3D;">${escapeHtml(e.text)}</span>
      ${e.summary ? `<div style="color:#6B7785;font-size:12.5px;margin-top:2px;">${escapeHtml(e.summary)}</div>` : ''}
    </li>`).join('');
  const more = events.length > shown.length
    ? `<p style="margin:0 0 14px;font-size:12.5px;color:#6B7785;">…and ${events.length - shown.length} more.</p>`
    : '';

  const inner = `
    <p style="margin:0 0 6px;font-size:16px;font-weight:700;">${escapeHtml(subject)}</p>
    ${dealTitle ? `<p style="margin:0 0 14px;color:#6B7785;font-size:13px;">For ${escapeHtml(dealTitle)}</p>` : ''}
    ${finalised
      ? '<p style="margin:0 0 14px;">The brief is now locked, so it can\'t be changed. If something needs to move, just reply and we\'ll reopen it.</p>'
      : '<p style="margin:0 0 14px;">Here\'s what moved since you last heard from us:</p>'}
    <ul style="margin:0 0 16px;padding-left:18px;font-size:13.5px;line-height:1.5;">${items}</ul>
    ${more}
    <p style="margin:18px 0 6px;">
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">Open the brief</a>
    </p>
    <p style="margin:10px 0 0;font-size:12px;color:#6B7785;">
      You're getting this because you have access to this brief. We send at most one of these an hour.
    </p>`;

  const text = [
    subject,
    '',
    ...shown.map((e) => `· ${e.text}${e.summary ? ` — ${e.summary}` : ''}`),
    '',
    url,
  ].join('\n');

  return { subject, inner, text };
}

// Everything undigested that has settled. Grouped in JS rather than SQL because
// the grouping needs the same serialiser the portal feed uses — two
// descriptions of one change is exactly the drift this avoids.
async function pendingBatches() {
  const rows = await sql`
    SELECT e.id, e.brief_id, e.portal_user_id, e.staff_email, e.actor_name, e.event_key,
           e.question_key, e.question_label, e.before_value, e.after_value, e.created_at,
           b.company_id, b.title AS brief_title, b.deal_id,
           d.title AS deal_title
      FROM client_brief_events e
      JOIN client_briefs b ON b.id = e.brief_id
      LEFT JOIN deals d ON d.id = b.deal_id
     WHERE e.digested_at IS NULL
       AND e.created_at < NOW() - (${QUIET_MINUTES} * INTERVAL '1 minute')
       AND e.event_key <> 'brief.created'
     ORDER BY e.brief_id, e.created_at DESC
     LIMIT 2000
  `.catch(() => []);

  const byBrief = new Map();
  for (const r of rows) {
    if (!byBrief.has(r.brief_id)) {
      byBrief.set(r.brief_id, {
        briefId: r.brief_id,
        companyId: r.company_id,
        briefTitle: r.brief_title,
        dealTitle: r.deal_title,
        events: [],
        eventIds: [],
        stale: true,
      });
    }
    const batch = byBrief.get(r.brief_id);
    batch.events.push(serialiseEvent(r));
    batch.eventIds.push(r.id);
    // A batch is only stale if EVERY change in it is old.
    if (Date.now() - new Date(r.created_at).getTime() < STALE_HOURS * 3600_000) batch.stale = false;
  }
  return [...byBrief.values()].slice(0, MAX_BRIEFS_PER_RUN);
}

async function markDigested(ids) {
  if (!ids.length) return;
  await sql`UPDATE client_brief_events SET digested_at = NOW() WHERE id = ANY(${ids})`
    .catch((err) => console.warn('[brief] markDigested failed', err.message));
}

export async function runBriefDigest() {
  await ensureClientBriefs();
  const batches = await pendingBatches();
  let sent = 0;
  let skipped = 0;

  for (const batch of batches) {
    // Mark first. A send that fails costs one notification; a send that
    // succeeds and then fails to mark costs everyone a duplicate every hour
    // until someone notices — and that's the one people unsubscribe over.
    await markDigested(batch.eventIds);

    if (batch.stale) { skipped++; continue; }

    const actors = new Set(batch.events.map((e) => e.portalUserId).filter(Boolean));
    const members = await resolvePortalRecipients(batch.companyId);
    // Nobody is told about their own typing.
    const targets = members.filter((m) => !actors.has(m.id) && m.email);
    if (!targets.length) { skipped++; continue; }

    const url = `${PORTAL_URL}#/brief/${batch.briefId}`;
    const { subject, inner, text } = buildDigest({
      briefTitle: batch.briefTitle,
      dealTitle: batch.dealTitle,
      events: batch.events,
      url,
    });
    try {
      await sendMail({
        to: targets.map((t) => t.email),
        subject,
        html: briefDigestHtml({ inner }),
        text,
      });
      sent += targets.length;
    } catch (err) {
      console.warn('[brief] digest send failed', err.message);
    }
  }
  return { briefs: batches.length, sent, skipped };
}
