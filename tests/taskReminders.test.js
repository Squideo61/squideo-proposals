import { describe, it, expect } from 'vitest';
import { shouldRemind } from '../api/_lib/portal/tasks.js';

// The pure cadence decision behind cronClientTaskReminders. DB-free so it's
// unit-testable: remind when tasks are launched, still open, under the cap, and
// the cadence window has elapsed since the last reminder (or launch).

const DAY = 24 * 60 * 60 * 1000;
const launchedAt = '2026-07-01T09:00:00Z';

describe('shouldRemind', () => {
  it('does not remind before the first cadence window elapses', () => {
    const now = new Date(new Date(launchedAt).getTime() + 2 * DAY); // everyDays=3
    expect(shouldRemind({ launchedAt, remindedAt: null, count: 0, everyDays: 3, maxReminders: 3, openCount: 2, now })).toBe(false);
  });

  it('reminds once the window has elapsed with tasks still open', () => {
    const now = new Date(new Date(launchedAt).getTime() + 3 * DAY);
    expect(shouldRemind({ launchedAt, remindedAt: null, count: 0, everyDays: 3, maxReminders: 3, openCount: 2, now })).toBe(true);
  });

  it('measures the window from the last reminder, not launch', () => {
    const remindedAt = '2026-07-05T09:00:00Z';
    const soon = new Date(new Date(remindedAt).getTime() + 1 * DAY);
    const later = new Date(new Date(remindedAt).getTime() + 3 * DAY);
    expect(shouldRemind({ launchedAt, remindedAt, count: 1, everyDays: 3, maxReminders: 3, openCount: 1, now: soon })).toBe(false);
    expect(shouldRemind({ launchedAt, remindedAt, count: 1, everyDays: 3, maxReminders: 3, openCount: 1, now: later })).toBe(true);
  });

  it('stops at the reminder cap', () => {
    const now = new Date(new Date(launchedAt).getTime() + 30 * DAY);
    expect(shouldRemind({ launchedAt, remindedAt: null, count: 3, everyDays: 3, maxReminders: 3, openCount: 2, now })).toBe(false);
  });

  it('does not remind when there are no open tasks', () => {
    const now = new Date(new Date(launchedAt).getTime() + 30 * DAY);
    expect(shouldRemind({ launchedAt, remindedAt: null, count: 0, everyDays: 3, maxReminders: 3, openCount: 0, now })).toBe(false);
  });

  it('never reminds before tasks are launched', () => {
    const now = new Date(new Date(launchedAt).getTime() + 30 * DAY);
    expect(shouldRemind({ launchedAt: null, remindedAt: null, count: 0, everyDays: 3, maxReminders: 3, openCount: 2, now })).toBe(false);
  });
});
