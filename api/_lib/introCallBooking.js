// Shared booking core for intro calls AND project kick-off calls. Both the
// public token-gated route (api/intro-call/[action].js) and the authenticated
// customer portal (api/portal.js) call bookSlot() so the concurrency lock,
// Google Meet creation and team notification live in exactly one place.
//
// `kind` ('intro' | 'kickoff') only changes the wording and which notification
// key fires — the mechanics are identical.

import crypto from 'crypto';
import sql from './db.js';
import { sendNotification, resolveDealTeamEmails, ensureIntroCallNotificationDefault } from './notifications.js';
import { getFreshAccessToken } from './crm/gmail.js';
import { createEventWithMeet } from './googleCalendar.js';
import { mergeRules, computeSlots, computeSlotsForHosts } from './crm/introCallSlots.js';

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const makeBookingId = () => 'icb_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');

export function validTimezone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return null; }
}

export async function loadIntroCallRules() {
  const rows = await sql`SELECT intro_call_rules FROM settings WHERE id = 1`;
  return mergeRules(rows[0] && rows[0].intro_call_rules);
}

// Compute bookable slots for a deal (or an explicit host list). Thin wrapper so
// callers don't each re-load rules.
export async function computeBookingSlots({ dealId = null, hostEmails = [] }) {
  const rules = await loadIntroCallRules();
  const result = dealId
    ? await computeSlots(dealId, rules)
    : await computeSlotsForHosts(hostEmails, rules);
  return { rules, result };
}

// Create a booking. Returns { ok:true, start, end, meetUrl } or
// { ok:false, status, error, slots? } — the caller shapes the HTTP response.
export async function bookSlot({
  dealId = null, clientKey = null, linkToken = null, hostEmails = [],
  projectName = 'your project', name, email, company = '',
  startISO, timezone = null, kind = 'intro',
}) {
  name = String(name || '').trim();
  email = String(email || '').trim();
  company = String(company || '').trim();
  const start = String(startISO || '').trim();
  if (!name) return { ok: false, status: 400, error: 'Please enter your name.' };
  if (!EMAIL_RX.test(email)) return { ok: false, status: 400, error: 'Please enter a valid email.' };
  if (!start || isNaN(new Date(start).getTime())) return { ok: false, status: 400, error: 'Please choose a time.' };

  // Soft rate-limit per link (or per deal when there's no link) per hour.
  const recent = linkToken
    ? await sql`SELECT COUNT(*)::int AS n FROM intro_call_bookings WHERE link_token = ${linkToken} AND created_at > NOW() - INTERVAL '1 hour'`
    : dealId
      ? await sql`SELECT COUNT(*)::int AS n FROM intro_call_bookings WHERE deal_id = ${dealId} AND created_at > NOW() - INTERVAL '1 hour'`
      : [{ n: 0 }];
  if (recent[0].n >= 5) return { ok: false, status: 429, error: 'Too many booking attempts. Please try again later.' };

  // Server is authoritative: re-compute and confirm the chosen start is still free.
  const { rules, result } = await computeBookingSlots({ dealId, hostEmails });
  if (result.blocked.length) return { ok: false, status: 409, error: 'Booking is temporarily unavailable. Please try again later.' };
  const slot = result.slots.find((s) => s.start === new Date(start).toISOString());
  if (!slot) return { ok: false, status: 409, error: 'That time was just taken. Please pick another slot.', slots: result.slots };
  const organizer = result.organizer;
  const attendees = result.attendees;
  // Invited but not required to be free — the deal's owner. See
  // getDealAttendees for why they are kept out of the availability set.
  const optional = Array.isArray(result.optional) ? result.optional : [];
  if (!organizer) return { ok: false, status: 409, error: 'Booking is temporarily unavailable.' };

  const startUTC = new Date(slot.start);
  const endUTC = new Date(slot.end);
  const bookingId = makeBookingId();
  const clientTz = validTimezone(timezone);

  // Insert as the lock, then verify no overlap for this organizer (closes the
  // race free/busy alone can't since Google's view lags).
  await sql`
    INSERT INTO intro_call_bookings
      (id, deal_id, client_key, link_token, client_name, client_email, starts_at, ends_at,
       attendee_emails, organizer_email, status, client_timezone, kind)
    VALUES (${bookingId}, ${dealId}, ${clientKey}, ${linkToken}, ${name}, ${email},
       ${startUTC.toISOString()}, ${endUTC.toISOString()},
       ${[...attendees, ...optional]}::text[], ${organizer}, 'confirmed', ${clientTz}, ${kind})
  `;
  const clash = await sql`
    SELECT COUNT(*)::int AS n FROM intro_call_bookings
     WHERE status = 'confirmed' AND id <> ${bookingId}
       AND organizer_email = ${organizer}
       AND starts_at < ${endUTC.toISOString()} AND ends_at > ${startUTC.toISOString()}
  `;
  if (clash[0].n > 0) {
    await sql`DELETE FROM intro_call_bookings WHERE id = ${bookingId}`;
    return { ok: false, status: 409, error: 'That time was just taken. Please pick another slot.' };
  }

  const label = kind === 'kickoff' ? 'Kick-off call' : 'Intro call';
  let meetUrl = null;
  try {
    const token = await getFreshAccessToken(organizer);
    const event = await createEventWithMeet(token, {
      summary: `${label} — ${projectName}`,
      description: `${label} booked by ${name} (${email})${company ? ` from ${company}` : ''} for ${projectName}.`,
      start: startUTC,
      end: endUTC,
      attendees: [email, ...attendees],
      optionalAttendees: optional,
      requestId: bookingId,
    });
    meetUrl = event.meetUrl;
    await sql`UPDATE intro_call_bookings SET google_event_id = ${event.eventId}, meet_url = ${meetUrl} WHERE id = ${bookingId}`;
  } catch (err) {
    console.error('[booking] event creation failed', err.message);
    await sql`DELETE FROM intro_call_bookings WHERE id = ${bookingId}`;
    return { ok: false, status: 502, error: 'We could not confirm the booking with our calendar. Please try again.' };
  }

  if (dealId) {
    try {
      await sql`
        INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
        VALUES (${dealId}, ${kind === 'kickoff' ? 'kickoff_call_booked' : 'intro_call_booked'},
          ${JSON.stringify({ clientName: name, clientEmail: email, startsAt: startUTC.toISOString() })}, NULL)
      `;
    } catch (err) { console.warn('[booking] deal_event failed', err.message); }
  }

  try {
    const when = startUTC.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: rules.timezone });
    await ensureIntroCallNotificationDefault();
    // Everyone actually on the call, plus whoever owns the deal.
    //
    // resolveDealTeamEmails alone was the wrong set twice over: it reads
    // assignees + owner, so a producer who is neither — and who is usually
    // the ORGANIZER — was left out. Google does not email an organizer their
    // own event either, so the one person whose calendar the call lands in
    // could be the only one never told about it. That is what happened.
    const teamEmails = Array.from(new Set([
      ...(dealId ? await resolveDealTeamEmails(dealId, organizer) : []),
      organizer,
      ...attendees,
      ...optional,
    ].filter(Boolean).map((e) => String(e).toLowerCase())));
    await sendNotification('intro_call.booked', {
      assigneeEmails: teamEmails,
      subject: `${label} booked — ${projectName}`,
      html: callBookedHtml({ label, projectName, name: company ? `${name} (${company})` : name, email, when, meetUrl }),
      text: `${name}${company ? ` (${company})` : ''} (${email}) booked a ${label.toLowerCase()} for ${projectName} on ${when}.`,
      inApp: {
        title: `${label} booked — ${projectName}`,
        body: `${name} · ${when}`,
        link: dealId ? `#/deal/${dealId}` : null,
      },
    });
  } catch (err) { console.warn('[booking] notify failed', err.message); }

  return { ok: true, start: slot.start, end: slot.end, meetUrl, projectName };
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function callBookedHtml({ label, projectName, name, email, when, meetUrl }) {
  return `<!doctype html><html><body style="margin:0;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E9EE;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:24px 28px;">
        <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">New ${escapeHtml(label.toLowerCase())} booked</h2>
        <p style="margin:0 0 8px;"><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) booked a ${escapeHtml(label.toLowerCase())} for <strong>${escapeHtml(projectName)}</strong>.</p>
        <p style="margin:0 0 8px;">🗓 ${escapeHtml(when)}</p>
        ${meetUrl ? `<p style="margin:12px 0 0;"><a href="${escapeHtml(meetUrl)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Join Google Meet</a></p>` : ''}
        <p style="margin:16px 0 0;font-size:13px;color:#6B7785;">The event is on your Google Calendar with the client invited.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}
