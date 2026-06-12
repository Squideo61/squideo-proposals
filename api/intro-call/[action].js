// Public, token-gated Intro Call booking — the client-facing side of the
// feature. Mirrors api/revisions/[action].js (one file, action via [action]).
// No auth: the unguessable per-deal token IS the capability.
//
//   GET  /api/intro-call/public?token=…   — project name + duration + free slots
//   POST /api/intro-call/book?token=…     — create the booking (Google event + Meet)
import crypto from 'crypto';
import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';
import { APP_URL } from '../_lib/email.js';
import { sendNotification, resolveDealTeamEmails, ensureIntroCallNotificationDefault } from '../_lib/notifications.js';
import { getFreshAccessToken } from '../_lib/crm/gmail.js';
import { createEventWithMeet } from '../_lib/googleCalendar.js';
import {
  ensureIntroCallTables, mergeRules, computeSlots, getDealAttendees,
} from '../_lib/crm/introCallSlots.js';

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const makeBookingId = () => 'icb_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

async function loadRules() {
  const rows = await sql`SELECT intro_call_rules FROM settings WHERE id = 1`;
  return mergeRules(rows[0] && rows[0].intro_call_rules);
}

// Resolve a live token to its deal + a client-safe display name. Returns null
// for missing/revoked tokens.
async function resolveToken(token) {
  if (!token) return null;
  const rows = await sql`
    SELECT l.token, l.deal_id, d.title AS deal_title, c.name AS company_name
      FROM intro_call_links l
      JOIN deals d ON d.id = l.deal_id
      LEFT JOIN companies c ON c.id = d.company_id
     WHERE l.token = ${token} AND l.revoked_at IS NULL
     LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    token: r.token,
    dealId: r.deal_id,
    projectName: r.company_name || r.deal_title || 'your project',
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = String(req.query.action || '');
  try {
    await ensureIntroCallTables();

    if (action === 'public') {
      if (req.method !== 'GET') return res.status(405).end();
      return await publicSlots(req, res);
    }
    if (action === 'book') {
      if (req.method !== 'POST') return res.status(405).end();
      return await book(req, res);
    }
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[intro-call] unhandled', { action, method: req.method, err });
    return res.status(500).json({ error: 'Server error' });
  }
}

async function publicSlots(req, res) {
  const ctx = await resolveToken(req.query.token);
  if (!ctx) return res.status(404).json({ error: 'This booking link is no longer active.' });

  const rules = await loadRules();
  const result = await computeSlots(ctx.dealId, rules);
  // Never leak attendee emails or busy detail — only the project name, duration
  // and free slots. `ready` tells the page whether to show the picker or a
  // "team finishing setup" message.
  return res.status(200).json({
    projectName: ctx.projectName,
    durationMinutes: rules.durationMinutes,
    timezone: rules.timezone,
    ready: result.blocked.length === 0,
    slots: result.slots,
  });
}

async function book(req, res) {
  const ctx = await resolveToken(req.query.token);
  if (!ctx) return res.status(404).json({ error: 'This booking link is no longer active.' });

  const body = parseBody(req);
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const start = String(body.start || '').trim();
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!EMAIL_RX.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (!start || isNaN(new Date(start).getTime())) return res.status(400).json({ error: 'Please choose a time.' });

  // Soft rate-limit: cap bookings per token per hour to blunt abuse.
  const recent = await sql`
    SELECT COUNT(*)::int AS n FROM intro_call_bookings
     WHERE link_token = ${ctx.token} AND created_at > NOW() - INTERVAL '1 hour'
  `;
  if (recent[0].n >= 5) {
    return res.status(429).json({ error: 'Too many booking attempts. Please try again later.' });
  }

  // Server is authoritative: re-compute slots and confirm the chosen start is
  // still on offer (and learn the duration/attendees/organizer).
  const rules = await loadRules();
  const result = await computeSlots(ctx.dealId, rules);
  if (result.blocked.length) {
    return res.status(409).json({ error: 'Booking is temporarily unavailable. Please try again later.' });
  }
  const slot = result.slots.find((s) => s.start === new Date(start).toISOString());
  if (!slot) {
    return res.status(409).json({ error: 'That time was just taken. Please pick another slot.', slots: result.slots });
  }
  const organizer = result.organizer;
  const attendees = result.attendees;
  if (!organizer) return res.status(409).json({ error: 'Booking is temporarily unavailable.' });

  const startUTC = new Date(slot.start);
  const endUTC = new Date(slot.end);
  const bookingId = makeBookingId();

  // Insert first as the double-booking lock, then verify no other confirmed
  // booking overlaps for this organizer (closes the concurrent-request race that
  // free/busy alone can't, since Google's view lags).
  await sql`
    INSERT INTO intro_call_bookings
      (id, deal_id, link_token, client_name, client_email, starts_at, ends_at,
       attendee_emails, organizer_email, status)
    VALUES (${bookingId}, ${ctx.dealId}, ${ctx.token}, ${name}, ${email},
       ${startUTC.toISOString()}, ${endUTC.toISOString()},
       ${attendees}::text[], ${organizer}, 'confirmed')
  `;
  const clash = await sql`
    SELECT COUNT(*)::int AS n FROM intro_call_bookings
     WHERE status = 'confirmed' AND id <> ${bookingId}
       AND organizer_email = ${organizer}
       AND starts_at < ${endUTC.toISOString()} AND ends_at > ${startUTC.toISOString()}
  `;
  if (clash[0].n > 0) {
    await sql`DELETE FROM intro_call_bookings WHERE id = ${bookingId}`;
    return res.status(409).json({ error: 'That time was just taken. Please pick another slot.' });
  }

  // Create the Google Calendar event with a Meet link on the organizer's calendar.
  let meetUrl = null;
  try {
    const token = await getFreshAccessToken(organizer);
    const event = await createEventWithMeet(token, {
      summary: `Intro call — ${ctx.projectName}`,
      description: `Intro call booked by ${name} (${email}) for ${ctx.projectName}.`,
      start: startUTC,
      end: endUTC,
      attendees: [email, ...attendees],
      requestId: bookingId,
    });
    meetUrl = event.meetUrl;
    await sql`
      UPDATE intro_call_bookings
         SET google_event_id = ${event.eventId}, meet_url = ${meetUrl}
       WHERE id = ${bookingId}
    `;
  } catch (err) {
    console.error('[intro-call] event creation failed', err.message);
    await sql`DELETE FROM intro_call_bookings WHERE id = ${bookingId}`;
    return res.status(502).json({ error: 'We could not confirm the booking with our calendar. Please try again.' });
  }

  // Log a deal event + notify the team in-app/email (best-effort).
  try {
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${ctx.dealId}, 'intro_call_booked',
        ${JSON.stringify({ clientName: name, clientEmail: email, startsAt: startUTC.toISOString() })}, NULL)
    `;
  } catch (err) { console.warn('[intro-call] deal_event failed', err.message); }

  try {
    const when = startUTC.toLocaleString('en-GB', {
      dateStyle: 'full', timeStyle: 'short', timeZone: rules.timezone,
    });
    await ensureIntroCallNotificationDefault();
    const teamEmails = await resolveDealTeamEmails(ctx.dealId, organizer);
    await sendNotification('intro_call.booked', {
      assigneeEmails: teamEmails,
      subject: `Intro call booked — ${ctx.projectName}`,
      html: introCallBookedHtml({ projectName: ctx.projectName, name, email, when, meetUrl }),
      text: `${name} (${email}) booked an intro call for ${ctx.projectName} on ${when}.`,
      inApp: {
        title: `Intro call booked — ${ctx.projectName}`,
        body: `${name} · ${when}`,
        link: `#/deal/${ctx.dealId}`,
      },
    });
  } catch (err) { console.warn('[intro-call] notify failed', err.message); }

  return res.status(200).json({
    ok: true,
    start: slot.start,
    end: slot.end,
    meetUrl,
    projectName: ctx.projectName,
  });
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function introCallBookedHtml({ projectName, name, email, when, meetUrl }) {
  return `<!doctype html><html><body style="margin:0;background:#FAFBFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0F2A3D;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E9EE;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:24px 28px;">
        <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;">New intro call booked</h2>
        <p style="margin:0 0 8px;"><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) booked an intro call for <strong>${escapeHtml(projectName)}</strong>.</p>
        <p style="margin:0 0 8px;">🗓 ${escapeHtml(when)}</p>
        ${meetUrl ? `<p style="margin:12px 0 0;"><a href="${escapeHtml(meetUrl)}" style="display:inline-block;background:#2BB8E6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Join Google Meet</a></p>` : ''}
        <p style="margin:16px 0 0;font-size:13px;color:#6B7785;">The event is on your Google Calendar with the client invited.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}
