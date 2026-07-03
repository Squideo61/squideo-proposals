import { describe, it, expect } from 'vitest';
import {
  durationDaysForLength, addWorkingDays, nextWorkingDay, workingDaysBetween,
  countWorkingDays,
} from '../api/_lib/scheduleCalendar.js';

describe('durationDaysForLength', () => {
  it('maps video length to assigned working days', () => {
    expect(durationDaysForLength('30 seconds')).toBe(1);
    expect(durationDaysForLength('1 minute')).toBe(1);
    expect(durationDaysForLength('1.5 minutes')).toBe(2);
    expect(durationDaysForLength('2 minutes')).toBe(2);
    expect(durationDaysForLength('2.5 minutes')).toBe(3);
    expect(durationDaysForLength('3 minutes')).toBe(3);
    expect(durationDaysForLength('4 minutes')).toBe(4);
  });
  it('parses looser forms + falls back to a day', () => {
    expect(durationDaysForLength('90 seconds')).toBe(2);
    expect(durationDaysForLength('2')).toBe(2);
    expect(durationDaysForLength('1.5 min')).toBe(2);
    expect(durationDaysForLength('')).toBe(1);
    expect(durationDaysForLength(null)).toBe(1);
  });
});

describe('working-day arithmetic', () => {
  it('skips weekends when advancing', () => {
    // 2026-07-03 is a Friday. +1 working day → Monday 6th.
    expect(addWorkingDays('2026-07-03', 1)).toBe('2026-07-06');
    // 0 snaps forward off a weekend: Sat 4th → Mon 6th.
    expect(nextWorkingDay('2026-07-04')).toBe('2026-07-06');
  });
  it('goes backwards for negative n (internal-review buffer)', () => {
    // Monday 6th − 1 working day → Friday 3rd.
    expect(addWorkingDays('2026-07-06', -1)).toBe('2026-07-03');
  });
  it('counts inclusive working days between dates', () => {
    // Mon 6th → Fri 10th = 5 working days.
    expect(countWorkingDays('2026-07-06', '2026-07-10')).toBe(5);
    // Fri 3rd → Mon 6th spans a weekend = 2 working days.
    expect(workingDaysBetween('2026-07-03', '2026-07-06')).toEqual(['2026-07-03', '2026-07-06']);
  });
});
