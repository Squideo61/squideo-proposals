// UK numbers were grouped 5-3-3, which is a landline shape. On a mobile whose
// trunk 0 had already been stripped that produced "+44 79743 185 28" — a split
// landing mid-way through both halves of the number. You cannot read that back
// to someone over the phone, which is the entire job of the thing.
//
// The rule that works for every UK number is: the last six digits are their own
// group. What's pinned here is mostly the RESTRAINT — the formatter must leave
// anything it doesn't recognise completely alone, because silently regrouping a
// US or German number by a British rule is a worse bug than the one it fixes.
import { describe, it, expect } from 'vitest';
import { formatPhoneDisplay } from '../src/components/ui.jsx';

describe('UK numbers', () => {
  it('groups a mobile as 5 + 6', () => {
    expect(formatPhoneDisplay('07585110811')).toBe('07585 110811');
  });

  it('fixes the number that started this', () => {
    expect(formatPhoneDisplay('+44 79743 185 28')).toBe('+44 7974 318528');
  });

  it('keeps a +44 prefix and drops the trunk 0 that cannot coexist with it', () => {
    expect(formatPhoneDisplay('+44 (0)7926 838203')).toBe('+44 7926 838203');
    expect(formatPhoneDisplay('+44 07926838203')).toBe('+44 7926 838203');
  });

  it('handles a landline', () => {
    expect(formatPhoneDisplay('01482738656')).toBe('01482 738656');
  });

  it('recognises a country code written without the plus', () => {
    expect(formatPhoneDisplay('447974318528')).toBe('+44 7974 318528');
  });

  it('is idempotent — formatting an already-formatted number changes nothing', () => {
    const once = formatPhoneDisplay('07585110811');
    expect(formatPhoneDisplay(once)).toBe(once);
    const intl = formatPhoneDisplay('+44 79743 185 28');
    expect(formatPhoneDisplay(intl)).toBe(intl);
  });
});

describe('everything else is left alone', () => {
  it('does not apply a British rule to a US number', () => {
    expect(formatPhoneDisplay('(555) 123-4567')).toBe('(555) 123-4567');
    expect(formatPhoneDisplay('+1 555 123 4567')).toBe('+1 555 123 4567');
  });

  it('does not touch other international numbers', () => {
    expect(formatPhoneDisplay('+49 30 12345678')).toBe('+49 30 12345678');
    expect(formatPhoneDisplay('+33 1 23 45 67 89')).toBe('+33 1 23 45 67 89');
  });

  it('leaves an extension or a note where it was', () => {
    // Not a shape we can parse, so it survives verbatim rather than being
    // mangled into something that looks authoritative and isn't.
    expect(formatPhoneDisplay('01482 738656 ext 4')).toBe('01482 738656 ext 4');
  });

  it('survives empty, null and rubbish', () => {
    expect(formatPhoneDisplay('')).toBe('');
    expect(formatPhoneDisplay(null)).toBe('');
    expect(formatPhoneDisplay(undefined)).toBe('');
    expect(formatPhoneDisplay('n/a')).toBe('n/a');
  });

  it('shows a too-short number whole rather than inventing a gap', () => {
    expect(formatPhoneDisplay('0123')).toBe('0123');
  });
});
