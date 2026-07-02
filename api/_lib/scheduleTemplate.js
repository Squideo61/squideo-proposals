// Server-side mirror of the schedule-flattening logic in
// src/lib/scheduleTemplate.js. src/ and api/ can't cross-import (build
// isolation), so scheduleMilestones() is duplicated here. Keep the two in
// lockstep — the shape of a milestone item and the scheduleKey format must
// match what the client sends and expects back.

const FIELD_LABELS = {
  deliveredBy: 'Delivered by',
  feedbackBy: 'Feedback by',
  revisedBy: 'Revised by',
};

// Sections up to (but not including) the Storyboard stage are "script" work —
// their milestones also go to the copywriting/creative team (Chloe & Hannah).
// Everything from Storyboard onward is "production" — those also go to the
// project's producer. See assignment logic in api/_lib/crm/tasks.js.
const SCRIPT_SECTION_IDS = new Set(['pre_script']);

// Which assignment group a milestone belongs to, so tasks.js can route it to
// the right people (all milestones already go to the Production Managers).
export function scheduleAssignGroup(sectionId) {
  if (!sectionId) return 'base';           // Kick Off — Production Managers only
  return SCRIPT_SECTION_IDS.has(sectionId) ? 'script' : 'production';
}

// Convert a local "YYYY-MM-DDTHH:mm" string into an ISO timestamp. The value was
// authored in the browser's local zone; the client passes its current UTC offset
// (Date.getTimezoneOffset() minutes, e.g. -60 for BST) so the wall-clock time the
// user typed maps to the correct instant — otherwise a "17:00" milestone would
// display an hour off in the Tasks card during BST. Offset defaults to 0 (treat
// as UTC) for direct/legacy callers.
export function scheduleLocalToISO(local, tzOffsetMinutes = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || '');
  if (!m) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + (Number(tzOffsetMinutes) || 0) * 60000;
  return new Date(utcMs).toISOString();
}

// Flatten a stored schedule into the milestone items the sync endpoint
// reconciles into tasks: one per non-empty date field on an enabled row, plus a
// Kick Off item. `scheduleKey` is the stable dedupe identity. `tzOffsetMinutes`
// is the client's UTC offset (see scheduleLocalToISO).
export function scheduleMilestones(schedule, dealId, tzOffsetMinutes = 0) {
  const items = [];
  if (!schedule) return items;
  if (schedule.kickOff) {
    items.push({
      scheduleKey: `${dealId}:kick_off`,
      title: 'Kick Off',
      dueAt: scheduleLocalToISO(schedule.kickOff, tzOffsetMinutes),
      assignGroup: scheduleAssignGroup(null),
    });
  }
  for (const section of schedule.sections || []) {
    if (!section.enabled) continue;
    const assignGroup = scheduleAssignGroup(section.id);
    for (const row of section.rows || []) {
      if (!row.enabled) continue;
      for (const field of row.fields || []) {
        // "Approved by" was retired; skip it defensively for schedules saved
        // before the change that still carry the field.
        if (field === 'approvedBy') continue;
        const val = row[field];
        if (!val) continue;
        items.push({
          scheduleKey: `${dealId}:${row.id}:${field}`,
          title: `${row.label} — ${FIELD_LABELS[field] || field}`,
          dueAt: scheduleLocalToISO(val, tzOffsetMinutes),
          assignGroup,
        });
      }
    }
  }
  return items;
}
