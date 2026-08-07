// The production schedule, as a client should see it.
//
// The stored shape (src/lib/scheduleTemplate.js) is built for the team: nested
// sections and rows, enable flags, autofill state, three date fields per row
// named after the internal columns. None of that is a thing to hand a client.
// This flattens it to a plain list of dated moments in order, each labelled
// with whose move it is.
//
// The distinction that matters is `who`. "Delivered by" and "Revised by" are
// promises we've made; "Feedback by" is a date the CLIENT has to hit, and it is
// the single most useful thing on the whole schedule for them — a project slips
// most often because nobody told the client their week was the critical path.
//
// Times are dropped. The team schedules to 17:00 on a Thursday; a client needs
// the day. Keeping the time would also mean taking a position on their timezone
// for a value that was authored in ours.

const EVENTS = {
  deliveredBy: { event: 'With you', who: 'us' },
  feedbackBy: { event: 'Your feedback due', who: 'you' },
  revisedBy: { event: 'Revised version with you', who: 'us' },
};
// Retired field, still present on schedules saved before it was dropped.
const SKIP_FIELDS = new Set(['approvedBy']);

const dayOf = (local) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(local || ''));
  return m ? m[1] : null;
};

// Returns { kickOff, milestones: [{ key, label, event, who, date }] } or null
// when there's nothing dated to show. Never throws on a malformed blob — a
// schedule saved by an older version must degrade to "no schedule yet", not
// take the client's project page down.
export function clientSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  const milestones = [];

  const kickOff = dayOf(schedule.kickOff);
  if (kickOff) {
    milestones.push({ key: 'kick_off', label: 'Kick off', event: 'Project starts', who: 'both', date: kickOff });
  }

  for (const section of Array.isArray(schedule.sections) ? schedule.sections : []) {
    if (!section || section.enabled === false) continue;
    for (const row of Array.isArray(section.rows) ? section.rows : []) {
      if (!row || row.enabled === false) continue;
      for (const field of Array.isArray(row.fields) ? row.fields : []) {
        if (SKIP_FIELDS.has(field)) continue;
        const meta = EVENTS[field];
        const date = dayOf(row[field]);
        if (!meta || !date) continue;
        milestones.push({
          key: `${row.id}:${field}`,
          label: row.label || row.id || 'Milestone',
          event: meta.event,
          who: meta.who,
          date,
        });
      }
    }
  }

  if (!milestones.length) return null;
  // Chronological, because that's the only order a timeline can be read in.
  // The stored order is the team's layout, which interleaves once a row slips.
  milestones.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { kickOff, milestones };
}
