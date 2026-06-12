// Authenticated Intro Call routes (deal-page link + per-user availability +
// admin booking rules). Dispatched from api/crm/[...slug].js as `intro-calls`.
//
//   GET    /api/crm/intro-calls/:dealId         — link status + readiness + recent bookings
//   POST   /api/crm/intro-calls/:dealId/link    — generate (or return active) share link
//   DELETE /api/crm/intro-calls/:dealId/link    — revoke the active link
//   POST   /api/crm/intro-calls/:dealId/cancel  — cancel a booked call (body: { bookingId })
//   GET    /api/crm/intro-calls/availability    — current user's working days/hours
//   PUT    /api/crm/intro-calls/availability    — replace current user's availability
//   GET    /api/crm/intro-calls/rules           — global booking rules
//   PUT    /api/crm/intro-calls/rules           — edit global rules (settings.manage)
import crypto from 'crypto';
import sql from '../db.js';
import { APP_URL } from '../email.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { trimOrNull } from './shared.js';
import { getFreshAccessToken } from './gmail.js';
import { deleteEvent } from '../googleCalendar.js';
import {
  ensureIntroCallTables, mergeRules, DEFAULT_RULES,
  computeSlots, getDealAttendees,
} from './introCallSlots.js';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // 0=Mon … 6=Sun

async function loadRules() {
  const rows = await sql`SELECT intro_call_rules FROM settings WHERE id = 1`;
  return mergeRules(rows[0] && rows[0].intro_call_rules);
}

export async function introCallsRoute(req, res, id, action, user) {
  await ensureIntroCallTables();

  // ── Per-user availability ──────────────────────────────────────────────────
  if (id === 'availability') {
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT weekday, is_working, start_minute, end_minute
          FROM staff_availability WHERE user_email = ${user.email}
      `;
      const byDay = {};
      for (const r of rows) byDay[r.weekday] = r;
      const days = WEEKDAYS.map((w) => {
        const r = byDay[w];
        return {
          weekday: w,
          isWorking: r ? r.is_working : w < 5,
          startMinute: r ? r.start_minute : DEFAULT_RULES.earliestMinute,
          endMinute: r ? r.end_minute : DEFAULT_RULES.latestEndMinute,
        };
      });
      return res.status(200).json({ days });
    }
    if (req.method === 'PUT') {
      const days = Array.isArray(req.body?.days) ? req.body.days : [];
      const clean = days
        .filter((d) => WEEKDAYS.includes(Number(d.weekday)))
        .map((d) => ({
          weekday: Number(d.weekday),
          isWorking: !!d.isWorking,
          start: clampMinute(d.startMinute, DEFAULT_RULES.earliestMinute),
          end: clampMinute(d.endMinute, DEFAULT_RULES.latestEndMinute),
        }));
      for (const d of clean) {
        if (d.end <= d.start) d.end = Math.min(1440, d.start + 30);
        // eslint-disable-next-line no-await-in-loop
        await sql`
          INSERT INTO staff_availability (user_email, weekday, is_working, start_minute, end_minute)
          VALUES (${user.email}, ${d.weekday}, ${d.isWorking}, ${d.start}, ${d.end})
          ON CONFLICT (user_email, weekday) DO UPDATE SET
            is_working = EXCLUDED.is_working,
            start_minute = EXCLUDED.start_minute,
            end_minute = EXCLUDED.end_minute
        `;
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  // ── Global booking rules ───────────────────────────────────────────────────
  if (id === 'rules') {
    if (req.method === 'GET') {
      return res.status(200).json({ rules: await loadRules() });
    }
    if (req.method === 'PUT') {
      if (!hasPermission(await getRole(user.role), 'settings.manage')) {
        return res.status(403).json({ error: 'You do not have permission to edit booking rules' });
      }
      const merged = mergeRules(req.body?.rules);
      await sql`UPDATE settings SET intro_call_rules = ${JSON.stringify(merged)}::jsonb WHERE id = 1`;
      return res.status(200).json({ rules: merged });
    }
    return res.status(405).end();
  }

  // ── Per-deal link ──────────────────────────────────────────────────────────
  if (!id) return res.status(404).json({ error: 'Deal id required' });

  if (action === 'link') {
    const deal = (await sql`SELECT id FROM deals WHERE id = ${id}`)[0];
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    if (req.method === 'POST') {
      const existing = (await sql`
        SELECT token FROM intro_call_links
         WHERE deal_id = ${id} AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1
      `)[0];
      let token = existing?.token;
      if (!token) {
        token = crypto.randomBytes(24).toString('base64url');
        await sql`
          INSERT INTO intro_call_links (token, deal_id, created_by)
          VALUES (${token}, ${id}, ${user.email || null})
        `;
        await sql`
          INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
          VALUES (${id}, 'intro_call_link_generated', ${JSON.stringify({})}, ${user.email || null})
        `;
      }
      return res.status(200).json({ token, url: `${APP_URL}/?introCall=${token}` });
    }
    if (req.method === 'DELETE') {
      await sql`UPDATE intro_call_links SET revoked_at = NOW() WHERE deal_id = ${id} AND revoked_at IS NULL`;
      return res.status(200).json({ ok: true });
    }
    return res.status(405).end();
  }

  if (action === 'cancel') {
    if (req.method !== 'POST') return res.status(405).end();
    const bookingId = trimOrNull(req.body?.bookingId);
    if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
    const b = (await sql`
      SELECT id, organizer_email, google_event_id, status
        FROM intro_call_bookings WHERE id = ${bookingId} AND deal_id = ${id}
    `)[0];
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    if (b.status === 'cancelled') return res.status(200).json({ ok: true });
    // Remove the Google event (sendUpdates=all notifies the client + team).
    // Best-effort: a calendar hiccup shouldn't block freeing the slot.
    try {
      const tok = await getFreshAccessToken(b.organizer_email);
      await deleteEvent(tok, b.google_event_id);
    } catch (err) {
      console.warn('[intro-calls] event delete failed', err.message);
    }
    await sql`UPDATE intro_call_bookings SET status = 'cancelled' WHERE id = ${bookingId}`;
    await sql`
      INSERT INTO deal_events (deal_id, event_type, payload, actor_email)
      VALUES (${id}, 'intro_call_cancelled', ${JSON.stringify({ bookingId })}, ${user.email || null})
    `;
    return res.status(200).json({ ok: true });
  }

  // GET /api/crm/intro-calls/:dealId — status for the deal-page card.
  if (req.method === 'GET') {
    const link = (await sql`
      SELECT token, created_at FROM intro_call_links
       WHERE deal_id = ${id} AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1
    `)[0] || null;

    const bookings = await sql`
      SELECT id, client_name, client_email, starts_at, ends_at, meet_url, status
        FROM intro_call_bookings
       WHERE deal_id = ${id}
       ORDER BY starts_at DESC LIMIT 10
    `;

    // Readiness: who's on the team and is anyone unable to be booked. computeSlots
    // does the free/busy + connection checks; we only surface counts + blockers.
    let attendees = [];
    let blocked = [];
    let slotsAvailable = 0;
    try {
      const rules = await loadRules();
      const result = await computeSlots(id, rules);
      attendees = result.attendees;
      blocked = result.blocked;
      slotsAvailable = result.slots.length;
    } catch (err) {
      console.warn('[intro-calls] readiness check failed', err.message);
      const t = await getDealAttendees(id);
      attendees = t.attendees;
    }

    return res.status(200).json({
      link: link ? { token: link.token, url: `${APP_URL}/?introCall=${link.token}`, createdAt: link.created_at } : null,
      attendees,
      blocked,
      slotsAvailable,
      bookings: bookings.map(serialiseBooking),
    });
  }

  return res.status(405).end();
}

function clampMinute(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1440, Math.round(n)));
}

export function serialiseBooking(b) {
  return {
    id: b.id,
    clientName: b.client_name,
    clientEmail: b.client_email,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    meetUrl: b.meet_url,
    status: b.status,
  };
}
