// Intro Call slot computation.
//
// Given a deal, work out the bookable 30-min slots over the next N days by
// intersecting every attendee's personal working window (staff_availability)
// with the global rules, then removing anything that clashes with an attendee's
// Google free/busy or an existing confirmed booking.
//
// TIMEZONE: working windows are LOCAL Europe/London wall-clock minutes. We
// project them to absolute UTC instants using Intl (never hand-rolled offsets),
// so BST/GMT transitions are handled correctly. Everything compared/stored
// downstream is UTC.

import sql from '../db.js';
import { getFreshAccessToken } from './gmail.js';
import { freeBusy } from '../googleCalendar.js';

const TZ = 'Europe/London';

export const DEFAULT_RULES = {
  minNoticeHours: 24,
  earliestMinute: 600,          // 10:00
  latestEndMinute: 1020,        // 17:00 close → last slot 16:30–17:00
  fridayLatestEndMinute: 960,   // 16:00 close → last slot 15:30–16:00
  lunchStartMinute: 780,        // 13:00
  lunchEndMinute: 840,          // 14:00
  durationMinutes: 30,
  slotGranularityMinutes: 30,
  lookaheadDays: 14,
  timezone: TZ,
};

export function mergeRules(stored) {
  return { ...DEFAULT_RULES, ...(stored && typeof stored === 'object' ? stored : {}) };
}

// ── Self-heal (db/migrations/20260612_intro_call_booking.sql) ────────────────
let introCallTablesEnsured = null;
export function ensureIntroCallTables() {
  if (introCallTablesEnsured) return introCallTablesEnsured;
  introCallTablesEnsured = (async () => {
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS intro_call_rules JSONB`;
    await sql`CREATE TABLE IF NOT EXISTS staff_availability (
      user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      weekday      SMALLINT NOT NULL,
      is_working   BOOLEAN NOT NULL DEFAULT TRUE,
      start_minute SMALLINT NOT NULL DEFAULT 600,
      end_minute   SMALLINT NOT NULL DEFAULT 1020,
      PRIMARY KEY (user_email, weekday)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS intro_call_links (
      token       TEXT PRIMARY KEY,
      deal_id     TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      created_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at  TIMESTAMPTZ
    )`;
    await sql`CREATE INDEX IF NOT EXISTS intro_call_links_deal_idx ON intro_call_links(deal_id)`;
    await sql`CREATE TABLE IF NOT EXISTS intro_call_bookings (
      id              TEXT PRIMARY KEY,
      deal_id         TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      link_token      TEXT REFERENCES intro_call_links(token) ON DELETE SET NULL,
      client_name     TEXT NOT NULL,
      client_email    TEXT NOT NULL,
      starts_at       TIMESTAMPTZ NOT NULL,
      ends_at         TIMESTAMPTZ NOT NULL,
      attendee_emails TEXT[] NOT NULL,
      organizer_email TEXT NOT NULL,
      google_event_id TEXT,
      meet_url        TEXT,
      status          TEXT NOT NULL DEFAULT 'confirmed',
      reminder_sent_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`ALTER TABLE intro_call_bookings ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`;
    await sql`CREATE INDEX IF NOT EXISTS intro_call_bookings_deal_idx ON intro_call_bookings(deal_id)`;
    await sql`CREATE INDEX IF NOT EXISTS intro_call_bookings_slot_idx ON intro_call_bookings(organizer_email, starts_at)`;
  })().catch((err) => { introCallTablesEnsured = null; throw err; });
  return introCallTablesEnsured;
}

// ── Timezone helpers (Intl-based, DST-safe) ──────────────────────────────────

// Offset in minutes that Europe/London is ahead of UTC at the given instant
// (+60 during BST, 0 during GMT).
function londonOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Convert a London wall-clock {y, mo (1-12), d, minutes-from-midnight} to the
// absolute UTC instant. Business hours (10:00–17:00) avoid the 01:00–02:00 DST
// fold, so a single offset re-check resolves the transition days correctly.
function londonWallClockToUTC(y, mo, d, minutes) {
  const h = Math.floor(minutes / 60);
  const mi = minutes % 60;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = londonOffsetMinutes(new Date(guess));
  let utc = guess - off1 * 60000;
  const off2 = londonOffsetMinutes(new Date(utc));
  if (off2 !== off1) utc = guess - off2 * 60000;
  return new Date(utc);
}

// London calendar parts for an instant: { y, mo, d, weekday } where weekday is
// 0=Mon … 6=Sun.
function londonParts(date) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const wmap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { y: +p.year, mo: +p.month, d: +p.day, weekday: wmap[p.weekday] };
}

// ── Attendees + availability ─────────────────────────────────────────────────

// The production team for a deal: the producer/PM (deals.producer_email) plus
// every deal_assignees row. Deduped, lowercased. The first element (producer,
// else first assignee) is the organizer whose calendar holds the event.
export async function getDealAttendees(dealId) {
  const rows = await sql`
    SELECT producer_email FROM deals WHERE id = ${dealId}
  `;
  if (!rows.length) return { organizer: null, attendees: [] };
  const producer = rows[0].producer_email ? String(rows[0].producer_email).toLowerCase() : null;
  let assignees = [];
  try {
    const arows = await sql`SELECT user_email FROM deal_assignees WHERE deal_id = ${dealId} ORDER BY assigned_at`;
    assignees = arows.map((r) => String(r.user_email).toLowerCase());
  } catch (_) { /* deal_assignees not yet migrated */ }
  const ordered = [];
  for (const e of [producer, ...assignees]) {
    if (e && !ordered.includes(e)) ordered.push(e);
  }
  return { organizer: ordered[0] || null, attendees: ordered };
}

// Availability rows for a set of users, keyed email → weekday → {isWorking,start,end}.
async function loadAvailability(emails) {
  const out = {};
  if (!emails.length) return out;
  const rows = await sql`
    SELECT user_email, weekday, is_working, start_minute, end_minute
      FROM staff_availability
     WHERE user_email = ANY(${emails})
  `;
  for (const r of rows) {
    const e = String(r.user_email).toLowerCase();
    (out[e] = out[e] || {})[r.weekday] = {
      isWorking: r.is_working, start: r.start_minute, end: r.end_minute,
    };
  }
  return out;
}

// ── Slot computation ─────────────────────────────────────────────────────────

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

// Compute bookable slots for a deal.
// Returns { organizer, attendees, slots: [{start, end}] (ISO UTC), blocked: [{email, reason}] }.
// If any attendee can't be checked (not connected / missing Calendar scope),
// slots is empty and blocked lists who needs attention.
export async function computeSlots(dealId, rules) {
  const r = mergeRules(rules);
  const { organizer, attendees } = await getDealAttendees(dealId);
  if (!attendees.length) {
    return { organizer: null, attendees: [], slots: [], blocked: [{ email: null, reason: 'no_team' }] };
  }

  const now = Date.now();
  const windowStart = new Date(now + r.minNoticeHours * 3600_000);
  const windowEnd = new Date(now + r.lookaheadDays * 86400_000);

  // Per-attendee free/busy + connection check.
  const busyByEmail = {};
  const blocked = [];
  for (const email of attendees) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const token = await getFreshAccessToken(email);
      // eslint-disable-next-line no-await-in-loop
      busyByEmail[email] = await freeBusy(token, { timeMin: windowStart, timeMax: windowEnd });
    } catch (err) {
      const reason = err.code === 'REAUTH_CALENDAR' ? 'needs_calendar'
        : err.code === 'NOT_CONNECTED' ? 'not_connected'
        : err.code === 'REAUTH' ? 'reauth'
        : 'error';
      blocked.push({ email, reason });
    }
  }
  if (blocked.length) {
    return { organizer, attendees, slots: [], blocked };
  }

  // Existing confirmed bookings that tie up any attendee in the window.
  const bookingRows = await sql`
    SELECT starts_at, ends_at FROM intro_call_bookings
     WHERE status = 'confirmed'
       AND ends_at > ${windowStart.toISOString()}
       AND (organizer_email = ANY(${attendees}) OR attendee_emails && ${attendees}::text[])
  `;
  const bookedBusy = bookingRows.map((b) => ({ start: new Date(b.starts_at), end: new Date(b.ends_at) }));

  const avail = await loadAvailability(attendees);

  const slots = [];
  // Iterate London calendar days from the window start. Anchor each day at UTC
  // noon (safe from DST folds) to read its London date/weekday.
  const first = londonParts(windowStart);
  for (let i = 0; i <= r.lookaheadDays; i++) {
    const dayAnchor = new Date(Date.UTC(first.y, first.mo - 1, first.d + i, 12, 0, 0));
    const { y, mo, d, weekday } = londonParts(dayAnchor);

    // Intersect every attendee's working window for this weekday.
    let winStart = r.earliestMinute;
    let winEnd = weekday === 4 ? r.fridayLatestEndMinute : r.latestEndMinute;
    let everyoneWorks = true;
    for (const email of attendees) {
      const a = (avail[email] && avail[email][weekday]) || defaultDay(weekday, r);
      if (!a.isWorking) { everyoneWorks = false; break; }
      winStart = Math.max(winStart, a.start);
      winEnd = Math.min(winEnd, a.end);
    }
    if (!everyoneWorks || winStart >= winEnd) continue;

    // Split around lunch.
    const subWindows = subtractLunch(winStart, winEnd, r.lunchStartMinute, r.lunchEndMinute);
    for (const [subStart, subEnd] of subWindows) {
      for (let t = subStart; t + r.durationMinutes <= subEnd; t += r.slotGranularityMinutes) {
        const startUTC = londonWallClockToUTC(y, mo, d, t);
        const endUTC = londonWallClockToUTC(y, mo, d, t + r.durationMinutes);
        if (startUTC.getTime() < windowStart.getTime()) continue;
        if (endUTC.getTime() > windowEnd.getTime()) continue;
        if (slotClashes(startUTC, endUTC, attendees, busyByEmail, bookedBusy)) continue;
        slots.push({ start: startUTC.toISOString(), end: endUTC.toISOString() });
      }
    }
  }

  return { organizer, attendees, slots, blocked: [] };
}

// A weekday with no stored row falls back to the global window, treating Sat/Sun
// as non-working by default.
function defaultDay(weekday, r) {
  if (weekday >= 5) return { isWorking: false, start: r.earliestMinute, end: r.latestEndMinute };
  return { isWorking: true, start: r.earliestMinute, end: r.latestEndMinute };
}

function subtractLunch(start, end, lunchStart, lunchEnd) {
  if (lunchEnd <= start || lunchStart >= end) return [[start, end]];
  const out = [];
  if (lunchStart > start) out.push([start, Math.min(lunchStart, end)]);
  if (lunchEnd < end) out.push([Math.max(lunchEnd, start), end]);
  return out.filter(([s, e]) => e > s);
}

function slotClashes(startUTC, endUTC, attendees, busyByEmail, bookedBusy) {
  for (const email of attendees) {
    const busy = busyByEmail[email] || [];
    for (const b of busy) {
      if (overlaps(startUTC, endUTC, b.start, b.end)) return true;
    }
  }
  for (const b of bookedBusy) {
    if (overlaps(startUTC, endUTC, b.start, b.end)) return true;
  }
  return false;
}
