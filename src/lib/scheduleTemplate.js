// Production-schedule model + helpers. A project's schedule is a single JSON
// blob stored on the deal (deals.production_schedule); this file is the source
// of truth for its shape, the working-day auto-fill, and the flattening that
// turns it into milestone tasks. Kept dependency-free so both the modal and any
// pure logic can import it. (An identical scheduleMilestones() lives on the
// server — api/_lib/scheduleTemplate.js — because src/ and api/ can't
// cross-import. Keep the two in lockstep.)

// Date strings are the same local "YYYY-MM-DDTHH:mm" the task form speaks, so
// they feed straight into the shared DateTimePicker.

const SCHEDULE_VERSION = 1;

// Per-field labels used in the modal columns, export doc, and milestone titles.
// ("Approved by" was retired — the sign-off date added clutter without value.)
export const FIELD_LABELS = {
  deliveredBy: 'Delivered by',
  feedbackBy: 'Feedback by',
  revisedBy: 'Revised by',
};
export const FIELD_ORDER = ['deliveredBy', 'feedbackBy', 'revisedBy'];

// The canonical section/row layout, mirroring the Word doc. Row ids line up with
// VIDEO_MILESTONES (script / storyboard / video) so labels stay in lockstep.
// `enabled: false` seeds a row that only appears once the user ticks it (Style
// examples is optional). `offsetDays` are working-day gaps used by the
// Kick-Off auto-fill (see autofillFromKickOff): deliveredBy is measured from
// Kick Off; feedbackBy/revisedBy chain off the row's own deliveredBy.
export const SCHEDULE_TEMPLATE = [
  {
    id: 'pre_script',
    label: 'Pre-Production: Script / Text Direction',
    rows: [
      { id: 'style_examples', label: 'Style examples', enabled: false,
        fields: ['deliveredBy', 'feedbackBy'],
        offsets: { deliveredBy: 2, feedbackBy: 3 } },
      { id: 'script_text_direction', label: 'Script & Text Direction', enabled: true,
        fields: ['deliveredBy', 'feedbackBy'],
        offsets: { deliveredBy: 5, feedbackBy: 3 } },
    ],
  },
  {
    id: 'pre_storyboard',
    label: 'Pre-Production: Storyboard',
    rows: [
      { id: 'storyboard', label: 'Storyboard', enabled: true,
        fields: ['deliveredBy', 'feedbackBy', 'revisedBy'],
        offsets: { deliveredBy: 10, feedbackBy: 3, revisedBy: 5 } },
    ],
  },
  {
    id: 'production_animation',
    label: 'Production: Animation',
    rows: [
      { id: 'video', label: 'Video', enabled: true,
        fields: ['deliveredBy', 'feedbackBy', 'revisedBy'],
        offsets: { deliveredBy: 20, feedbackBy: 3, revisedBy: 5 } },
    ],
  },
];

// ── Working-day date maths ──

// Advance a Date by `n` Mon–Fri days (bank holidays not accounted for). n may be
// 0 (returns a copy, snapped forward off a weekend). Preserves the time-of-day.
export function addWorkingDays(date, n) {
  const d = new Date(date.getTime());
  let added = 0;
  // If we're starting on a weekend, roll to Monday first without consuming n.
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

function pad(n) { return String(n).padStart(2, '0'); }
function toLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocal(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
}

// ── Seeding + auto-fill ──

export function seedSchedule(deal) {
  const kick = deal?.productionStartDate
    ? `${String(deal.productionStartDate).slice(0, 10)}T09:00`
    : '';
  return {
    version: SCHEDULE_VERSION,
    kickOff: kick,
    autoFill: true,
    syncedAt: null,
    sections: SCHEDULE_TEMPLATE.map(s => ({
      id: s.id,
      label: s.label,
      enabled: true,
      rows: s.rows.map(r => ({
        id: r.id,
        label: r.label,
        enabled: r.enabled,
        fields: [...r.fields],
        deliveredBy: '', feedbackBy: '', revisedBy: '',
      })),
    })),
  };
}

// Return a new schedule with dates suggested from kickOff using the template's
// working-day offsets. Only fills fields that are currently blank (manual edits
// are preserved). deliveredBy is measured from Kick Off; feedbackBy/revisedBy
// chain off that row's deliveredBy. No-op if kickOff isn't set.
export function autofillFromKickOff(schedule) {
  const kick = fromLocal(schedule?.kickOff);
  if (!kick) return schedule;
  const tplRow = {};
  SCHEDULE_TEMPLATE.forEach(s => s.rows.forEach(r => { tplRow[r.id] = r; }));

  return {
    ...schedule,
    sections: schedule.sections.map(section => ({
      ...section,
      rows: section.rows.map(row => {
        const offsets = tplRow[row.id]?.offsets || {};
        const next = { ...row };
        const deliveredDate = offsets.deliveredBy != null ? addWorkingDays(kick, offsets.deliveredBy) : null;
        if (deliveredDate) deliveredDate.setHours(17, 0, 0, 0);
        if (!next.deliveredBy && deliveredDate) next.deliveredBy = toLocal(deliveredDate);
        const base = fromLocal(next.deliveredBy) || deliveredDate || kick;
        for (const f of ['feedbackBy', 'revisedBy']) {
          if (offsets[f] != null && !next[f] && base) {
            const d = addWorkingDays(base, offsets[f]);
            d.setHours(17, 0, 0, 0);
            next[f] = toLocal(d);
          }
        }
        return next;
      }),
    })),
  };
}

// ── Flattening for summary / export / milestones ──

// Only sections+rows that are switched on count anywhere.
export function enabledRows(schedule) {
  if (!schedule?.sections) return [];
  const out = [];
  for (const section of schedule.sections) {
    if (!section.enabled) continue;
    for (const row of section.rows) {
      if (!row.enabled) continue;
      out.push({ section, row });
    }
  }
  return out;
}

// NOTE: the flatten-to-milestones logic lives server-side only
// (api/_lib/scheduleTemplate.js scheduleMilestones) because the sync endpoint
// reads the schedule straight from the DB. The client never needs it — the card
// summary and export use enabledRows() above — so there's no client copy to
// keep in lockstep.
