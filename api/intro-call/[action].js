// Public, token-gated Intro Call booking — the client-facing side of the
// feature. Mirrors api/revisions/[action].js (one file, action via [action]).
// No auth: the unguessable per-deal token IS the capability.
//
//   GET  /api/intro-call/public?token=…   — project name + duration + free slots
//   POST /api/intro-call/book?token=…     — create the booking (Google event + Meet)
import sql from '../_lib/db.js';
import { cors } from '../_lib/middleware.js';
import { ensureIntroCallTables } from '../_lib/crm/introCallSlots.js';
import { bookSlot, computeBookingSlots } from '../_lib/introCallBooking.js';

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

// Resolve a live token to its deal OR partner client + a client-safe display
// name. Returns null for missing/revoked tokens.
async function resolveToken(token) {
  if (!token) return null;
  const rows = await sql`
    SELECT l.token, l.deal_id, l.client_key, l.client_name, l.host_emails,
           d.title AS deal_title, c.name AS company_name
      FROM intro_call_links l
      LEFT JOIN deals d ON d.id = l.deal_id
      LEFT JOIN companies c ON c.id = d.company_id
     WHERE l.token = ${token} AND l.revoked_at IS NULL
     LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    token: r.token,
    dealId: r.deal_id || null,
    clientKey: r.client_key || null,
    hostEmails: Array.isArray(r.host_emails) ? r.host_emails : [],
    projectName: r.company_name || r.deal_title || r.client_name || 'your project',
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

  const { rules, result } = await computeBookingSlots({ dealId: ctx.dealId, hostEmails: ctx.hostEmails });

  // Client-safe shape only: project name, duration and free slots. We don't
  // expose the assigned host (the team can change) or any attendee emails/busy
  // detail. `ready` tells the page whether to show the picker or a "team
  // finishing setup" message.
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
  const out = await bookSlot({
    dealId: ctx.dealId,
    clientKey: ctx.clientKey,
    linkToken: ctx.token,
    hostEmails: ctx.hostEmails,
    projectName: ctx.projectName,
    name: body.name,
    email: body.email,
    company: body.company,
    startISO: body.start,
    timezone: body.timezone,
    kind: 'intro',
  });
  if (!out.ok) {
    const payload = { error: out.error };
    if (out.slots) payload.slots = out.slots;
    return res.status(out.status).json(payload);
  }
  return res.status(200).json({ ok: true, start: out.start, end: out.end, meetUrl: out.meetUrl, projectName: out.projectName });
}
