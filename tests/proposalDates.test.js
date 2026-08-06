import { describe, it, expect } from 'vitest';
import { formatDateGB, parseDateGB, isoDate, freshExpiryISO } from '../api/_lib/proposalDates.js';

// A duplicated proposal has to expire relative to the day it was duplicated —
// carrying the original's fixed expiry date forward sends out a proposal that
// has already run out.

describe('formatDateGB / parseDateGB', () => {
  it('formats dd/mm/yyyy with zero padding', () => {
    expect(formatDateGB(new Date(2026, 7, 6))).toBe('06/08/2026');
    expect(formatDateGB(new Date(2026, 11, 25))).toBe('25/12/2026');
  });

  it('round-trips a UK date string', () => {
    expect(formatDateGB(parseDateGB('06/08/2026'))).toBe('06/08/2026');
  });

  it('accepts dots and dashes as separators', () => {
    expect(isoDate(parseDateGB('6.8.2026'))).toBe('2026-08-06');
    expect(isoDate(parseDateGB('6-8-2026'))).toBe('2026-08-06');
  });

  it('returns null for anything that is not a date', () => {
    expect(parseDateGB('')).toBeNull();
    expect(parseDateGB('next Tuesday')).toBeNull();
    expect(parseDateGB('2026-08-06')).toBeNull(); // ISO is the expiry format, not this one
  });
});

describe('freshExpiryISO', () => {
  const today = new Date(2026, 7, 6); // 6 Aug 2026

  it('leaves the expiry unset when the original had none', () => {
    expect(freshExpiryISO({ date: '01/07/2026', validityDays: 28 }, today)).toBeUndefined();
    expect(freshExpiryISO({}, today)).toBeUndefined();
    expect(freshExpiryISO(null, today)).toBeUndefined();
  });

  it('re-runs the original window from today', () => {
    // Issued 1 Jul, expired 15 Jul → a 14-day window, so 20 Aug from today.
    const out = freshExpiryISO({ date: '01/07/2026', expiryDate: '2026-07-15', validityDays: 28 }, today);
    expect(out).toBe('2026-08-20');
  });

  it('never returns a date in the past, even from a long-expired proposal', () => {
    const out = freshExpiryISO({ date: '01/01/2025', expiryDate: '2025-01-29', validityDays: 28 }, today);
    expect(new Date(out) > today).toBe(true);
  });

  it('falls back to validityDays when the original dates do not parse', () => {
    expect(freshExpiryISO({ date: 'sometime', expiryDate: '2026-07-15', validityDays: 10 }, today))
      .toBe('2026-08-16');
  });

  it('falls back to validityDays when the original expiry ran backwards', () => {
    // Expiry before the issue date — nonsense, so don't reapply it as a window.
    expect(freshExpiryISO({ date: '01/07/2026', expiryDate: '2026-06-01', validityDays: 7 }, today))
      .toBe('2026-08-13');
  });

  it('defaults to 28 days when no validityDays is set', () => {
    expect(freshExpiryISO({ date: 'sometime', expiryDate: '2026-07-15' }, today)).toBe('2026-09-03');
  });

  it('crosses a month and year boundary correctly', () => {
    const nye = new Date(2026, 11, 20);
    expect(freshExpiryISO({ date: '01/07/2026', expiryDate: '2026-07-29', validityDays: 28 }, nye))
      .toBe('2027-01-17');
  });
});
