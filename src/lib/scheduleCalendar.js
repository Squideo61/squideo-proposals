// Producer-schedule maths for the calendar UI — video-length → working-days
// duration, working-day date arithmetic on 'YYYY-MM-DD' strings (UTC-anchored),
// plus block colour-coding.
//
// This is the CLIENT copy. The shared pure helpers below are duplicated on the
// server at api/_lib/scheduleCalendar.js (src/ and api/ can't cross-import).
// Keep them in lockstep. The colour helpers at the bottom are UI-only.

// Video length → days for a stage. Handles presets ("1 minute (140w)"), word
// counts ("140w"), durations ("90 seconds"), Other-project day overrides
// ("4 days"), or bare numbers. days = max(1, ceil(words/140)) or ceil(minutes).
// Mirror of api/_lib/scheduleCalendar.js — keep in lockstep.
export function durationDaysForLength(videoLength) {
  const s = String(videoLength == null ? '' : videoLength).toLowerCase();
  const dm = /(\d+(?:\.\d+)?)\s*(?:days?|d)\b/.exec(s);
  if (dm) return Math.max(1, Math.round(+dm[1]));
  const wm = /(\d+)\s*w\b/.exec(s);
  if (wm) return Math.max(1, Math.ceil(+wm[1] / 140));
  const minutes = lengthToMinutes(videoLength);
  if (minutes == null) return 1;
  return Math.max(1, Math.ceil(minutes - 1e-9));
}
export function lengthToMinutes(videoLength) {
  if (videoLength == null) return null;
  const s = String(videoLength).toLowerCase().trim();
  if (!s) return null;
  const num = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!isFinite(num)) return null;
  if (/sec|\bs\b|"|''/.test(s) && !/min/.test(s)) return num / 60;
  return num;
}

// ── Working-day date arithmetic on 'YYYY-MM-DD' (UTC) ──
const DAY_MS = 86400000;
export function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
export function fmtDate(date) { return date.toISOString().slice(0, 10); }
export function todayStr() { return new Date().toISOString().slice(0, 10); }
export function dowUTC(str) { const d = parseDate(str); return d ? d.getUTCDay() : 0; }
export function isWeekend(str) { const d = dowUTC(str); return d === 0 || d === 6; }
export function addDays(str, n) {
  const d = parseDate(str);
  if (!d) return str;
  return fmtDate(new Date(d.getTime() + n * DAY_MS));
}
export function nextWorkingDay(str) { let s = str; while (isWeekend(s)) s = addDays(s, 1); return s; }
export function addWorkingDays(str, n) {
  let s = nextWorkingDay(str);
  const step = n >= 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) { s = addDays(s, step); while (isWeekend(s)) s = addDays(s, step); left -= 1; }
  return s;
}
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
export function countWorkingDays(startStr, endStr) { return workingDaysBetween(startStr, endStr).length; }

// Monday of the week containing `str` (weeks run Mon–Sun).
export function weekStart(str) {
  const dow = dowUTC(str);              // 0 Sun … 6 Sat
  const back = dow === 0 ? 6 : dow - 1; // days back to Monday
  return addDays(str, -back);
}
export function fmtDayLabel(str, opts = {}) {
  const d = parseDate(str);
  if (!d) return str;
  return d.toLocaleDateString('en-GB', { weekday: opts.weekday || 'short', day: 'numeric', month: opts.month || 'short', timeZone: 'UTC' });
}

// ── Block colour-coding (UI only) ──
// A stable per-project hue so blocks for the same project read together.
export function projectHue(dealId) {
  const s = String(dealId || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// The colour state for a block, per the brief:
//  - green  : the prerequisite stage is approved — ready for this stage.
//  - red    : not ready yet and the start date is approaching; deeper red the
//             closer (or once overdue).
//  - project: default — a stable per-project tint.
// `assignment.ready` (prerequisite approved) + `assignment.daysUntilStart`
// come from the server.
export function blockColorState(assignment) {
  if (assignment.ready) return 'ready';
  const d = assignment.daysUntilStart;
  if (d == null) return 'project';
  if (d <= 0) return 'red-4';
  if (d <= 2) return 'red-3';
  if (d <= 5) return 'red-2';
  if (d <= 9) return 'red-1';
  return 'project';
}

export function blockColors(assignment) {
  const state = blockColorState(assignment);
  if (state === 'ready') return { bg: '#16A34A', fg: '#fff', border: '#15803D' };
  const reds = {
    'red-1': { bg: '#FCA5A5', fg: '#7F1D1D', border: '#F87171' },
    'red-2': { bg: '#F87171', fg: '#fff', border: '#EF4444' },
    'red-3': { bg: '#EF4444', fg: '#fff', border: '#DC2626' },
    'red-4': { bg: '#B91C1C', fg: '#fff', border: '#991B1B' },
  };
  if (reds[state]) return reds[state];
  const h = projectHue(assignment.dealId);
  return { bg: `hsl(${h} 70% 92%)`, fg: `hsl(${h} 70% 28%)`, border: `hsl(${h} 60% 78%)` };
}
