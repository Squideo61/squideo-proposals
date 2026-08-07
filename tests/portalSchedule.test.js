// The production schedule, flattened for a client. The stored shape is the
// team's (nested sections/rows, enable flags, three internal column names);
// this is the only thing standing between that and a client's project page,
// so both what it keeps and what it drops matter.
import { describe, it, expect } from 'vitest';
import { clientSchedule } from '../api/_lib/portal/schedule.js';

const row = (id, label, dates, extra = {}) => ({
  id, label, enabled: true, fields: Object.keys(dates), ...dates, ...extra,
});
const schedule = (sections, kickOff = '') => ({ version: 1, kickOff, sections });

const FULL = schedule([
  {
    id: 'pre_script',
    label: 'Pre-Production: Script / Text Direction',
    enabled: true,
    rows: [row('script_text_direction', 'Script & Text Direction', {
      deliveredBy: '2026-08-12T17:00', feedbackBy: '2026-08-17T17:00',
    })],
  },
  {
    id: 'pre_storyboard',
    label: 'Pre-Production: Storyboard',
    enabled: true,
    rows: [row('storyboard', 'Storyboard', {
      deliveredBy: '2026-08-24T17:00', feedbackBy: '2026-08-27T17:00', revisedBy: '2026-09-03T17:00',
    })],
  },
], '2026-08-05T09:00');

describe('clientSchedule', () => {
  it('flattens the nested team shape into a dated list', () => {
    const out = clientSchedule(FULL);
    expect(out.kickOff).toBe('2026-08-05');
    expect(out.milestones.map((m) => `${m.label} · ${m.event} · ${m.date}`)).toEqual([
      'Kick off · Project starts · 2026-08-05',
      'Script & Text Direction · With you · 2026-08-12',
      'Script & Text Direction · Your feedback due · 2026-08-17',
      'Storyboard · With you · 2026-08-24',
      'Storyboard · Your feedback due · 2026-08-27',
      'Storyboard · Revised version with you · 2026-09-03',
    ]);
  });

  // The whole point of showing this to a client: their own deadlines. If `who`
  // stopped distinguishing them, the timeline would read as "things Squideo
  // will do" and the amber "You" markers would vanish silently.
  it('marks the client\'s own deadlines as theirs', () => {
    const byEvent = Object.fromEntries(clientSchedule(FULL).milestones.map((m) => [m.event, m.who]));
    expect(byEvent['Your feedback due']).toBe('you');
    expect(byEvent['With you']).toBe('us');
    expect(byEvent['Revised version with you']).toBe('us');
  });

  it('orders chronologically, not by the team\'s layout', () => {
    // A row that slipped past a later section: the stored order no longer
    // matches the calendar, and a timeline out of order is worse than none.
    const out = clientSchedule(schedule([
      { id: 'b', label: 'B', enabled: true, rows: [row('video', 'Video', { deliveredBy: '2026-09-01T17:00' })] },
      { id: 'a', label: 'A', enabled: true, rows: [row('storyboard', 'Storyboard', { deliveredBy: '2026-08-01T17:00' })] },
    ]));
    expect(out.milestones.map((m) => m.date)).toEqual(['2026-08-01', '2026-09-01']);
  });

  it('drops the time — a client needs the day, not 17:00 in our timezone', () => {
    clientSchedule(FULL).milestones.forEach((m) => expect(m.date).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('skips disabled sections and rows', () => {
    const out = clientSchedule(schedule([
      { id: 'on', label: 'On', enabled: true, rows: [
        row('style_examples', 'Style examples', { deliveredBy: '2026-08-10T17:00' }, { enabled: false }),
        row('storyboard', 'Storyboard', { deliveredBy: '2026-08-11T17:00' }),
      ] },
      { id: 'off', label: 'Off', enabled: false, rows: [row('video', 'Video', { deliveredBy: '2026-08-12T17:00' })] },
    ]));
    expect(out.milestones.map((m) => m.label)).toEqual(['Storyboard']);
  });

  it('skips undated fields rather than inventing a date', () => {
    const out = clientSchedule(schedule([
      { id: 's', label: 'S', enabled: true, rows: [row('storyboard', 'Storyboard', {
        deliveredBy: '2026-08-11T17:00', feedbackBy: '', revisedBy: null,
      })] },
    ]));
    expect(out.milestones).toHaveLength(1);
  });

  it('ignores the retired approvedBy field older schedules still carry', () => {
    const out = clientSchedule(schedule([
      { id: 's', label: 'S', enabled: true, rows: [{
        id: 'storyboard', label: 'Storyboard', enabled: true,
        fields: ['deliveredBy', 'approvedBy'],
        deliveredBy: '2026-08-11T17:00', approvedBy: '2026-08-14T17:00',
      }] },
    ]));
    expect(out.milestones.map((m) => m.event)).toEqual(['With you']);
  });

  it('returns null when there is nothing dated to show', () => {
    expect(clientSchedule(null)).toBeNull();
    expect(clientSchedule(undefined)).toBeNull();
    expect(clientSchedule({})).toBeNull();
    expect(clientSchedule(schedule([]))).toBeNull();
    expect(clientSchedule(schedule([{ id: 's', label: 'S', enabled: true, rows: [] }]))).toBeNull();
  });

  // A blob written by an older version must degrade to "no schedule yet"
  // rather than taking the client's project page down with it.
  it('survives a malformed blob', () => {
    expect(() => clientSchedule('nonsense')).not.toThrow();
    expect(clientSchedule('nonsense')).toBeNull();
    expect(clientSchedule({ sections: 'nope' })).toBeNull();
    expect(clientSchedule({ sections: [null, { rows: null }] })).toBeNull();
    expect(clientSchedule({ kickOff: 'not-a-date', sections: [] })).toBeNull();
  });

  it('shows a kick-off date on its own even with no rows filled in yet', () => {
    const out = clientSchedule(schedule([], '2026-08-05T09:00'));
    expect(out.milestones).toEqual([
      { key: 'kick_off', label: 'Kick off', event: 'Project starts', who: 'both', date: '2026-08-05' },
    ]);
  });
});
