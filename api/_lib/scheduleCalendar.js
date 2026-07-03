// Producer-schedule maths — video-length → working-days duration, plus
// working-day date arithmetic on 'YYYY-MM-DD' strings (UTC-anchored so the
// server is deterministic regardless of instance timezone).
//
// This is the SERVER copy. An identical set of pure helpers lives at
// src/lib/scheduleCalendar.js for the calendar UI (which additionally has
// colour helpers the server doesn't need). Keep the shared helpers in lockstep.
//
// The greedy packer that turns these into a producer's calendar blocks lives in
// api/_lib/crm/schedule.js — it's server-only.

// Video length → days assigned for a single production stage.
//   30 seconds / 1 minute      = 1 day
//   1.5 minutes / 2 minutes    = 2 days
//   2.5 minutes / 3 minutes    = 3 days   … and so on.
// i.e. days = max(1, ceil(minutes)). Length is free text on the video
// ("1 minute", "90 seconds", "1.5 mins", or a bare number of minutes).
export function durationDaysForLength(videoLength) {
  const minutes = lengthToMinutes(videoLength);
  if (minutes == null) return 1; // unknown → assume a day so it still schedules
  return Math.max(1, Math.ceil(minutes - 1e-9));
}

export function lengthToMinutes(videoLength) {
  if (videoLength == null) return null;
  const s = String(videoLength).toLowerCase().trim();
  if (!s) return null;
  const num = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!isFinite(num)) return null;
  if (/sec|\bs\b|"|''/.test(s) && !/min/.test(s)) return num / 60;
  return num; // minutes (default) — "1 minute", "1.5 mins", or bare number
}

// ── Working-day date arithmetic on 'YYYY-MM-DD' (UTC) ──

const DAY_MS = 86400000;

export function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
export function fmtDate(date) {
  return date.toISOString().slice(0, 10);
}
export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
export function dowUTC(str) {
  const d = parseDate(str);
  return d ? d.getUTCDay() : 0; // 0 Sun … 6 Sat
}
export function isWeekend(str) {
  const d = dowUTC(str);
  return d === 0 || d === 6;
}
export function addDays(str, n) {
  const d = parseDate(str);
  if (!d) return str;
  return fmtDate(new Date(d.getTime() + n * DAY_MS));
}
// Roll forward to the next Mon–Fri (a no-op if already a weekday).
export function nextWorkingDay(str) {
  let s = str;
  while (isWeekend(s)) s = addDays(s, 1);
  return s;
}
// Advance `n` working days. n may be negative (steps backwards) or 0 (snaps to
// the next weekday). Bank holidays are not accounted for (matches the rest of
// the app's working-day maths).
export function addWorkingDays(str, n) {
  let s = nextWorkingDay(str);
  const step = n >= 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    s = addDays(s, step);
    while (isWeekend(s)) s = addDays(s, step);
    left -= 1;
  }
  return s;
}
// Inclusive list of working-day strings between two dates.
export function workingDaysBetween(startStr, endStr) {
  const out = [];
  const end = parseDate(endStr);
  let s = parseDate(startStr);
  if (!s || !end) return out;
  while (s.getTime() <= end.getTime()) {
    const str = fmtDate(s);
    if (!isWeekend(str)) out.push(str);
    s = new Date(s.getTime() + DAY_MS);
  }
  return out;
}
// Count of inclusive working days between two dates.
export function countWorkingDays(startStr, endStr) {
  return workingDaysBetween(startStr, endStr).length;
}
