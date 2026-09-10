// Credit balances are sums of ledger rows, and float addition leaves tails —
// a deal page was showing "2.3000000000000007 min credit free". One decimal
// place, shared by the CRM and the client portal so both read the same.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCreditMinutes } from '../src/lib/creditFormat.js';

describe('formatCreditMinutes', () => {
  it('drops the float tail off a summed balance', () => {
    expect(formatCreditMinutes(2.3000000000000007)).toBe('2.3');
    expect(formatCreditMinutes(0.1 + 0.2)).toBe('0.3');
  });

  it('rounds to the nearest tenth', () => {
    expect(formatCreditMinutes(2.34)).toBe('2.3');
    expect(formatCreditMinutes(2.35)).toBe('2.4');   // EPSILON keeps .x5 rounding up
    expect(formatCreditMinutes(2.96)).toBe('3');     // rounds up into a whole minute
  });

  it('prints whole minutes without a trailing .0', () => {
    expect(formatCreditMinutes(5)).toBe('5');
    expect(formatCreditMinutes(5.0000000001)).toBe('5');
  });

  it('rounds negatives the same way as positives, and never prints -0', () => {
    expect(formatCreditMinutes(-2.35)).toBe('-2.4');
    expect(formatCreditMinutes(-0.01)).toBe('0');
  });

  it('treats missing values as nothing rather than NaN', () => {
    expect(formatCreditMinutes(null)).toBe('0');
    expect(formatCreditMinutes(undefined)).toBe('0');
    expect(formatCreditMinutes('')).toBe('0');
  });
});

describe('every credit balance goes through it', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => readFileSync(resolve(root, p), 'utf8');

  it('is what the CRM credit formatter delegates to', () => {
    expect(read('src/components/crm/creditDisplay.jsx')).toContain('export const fmtCredits = formatCreditMinutes');
  });

  it('formats the deal page credit pill — the one printing the raw float', () => {
    const deal = read('src/components/crm/DealDetailView.jsx');
    expect(deal).toContain('fmtCredits(detail.companyCredit.available ?? detail.companyCredit.remaining)');
    expect(deal).not.toMatch(/\{detail\.companyCredit\.available \?\? detail\.companyCredit\.remaining\} min/);
  });

  it('formats the credit balances the client sees in the portal', () => {
    expect(read('src/portal/pages/Dashboard.jsx')).toContain('formatCreditMinutes(project.credit.remaining)');
    expect(read('src/portal/pages/VideoCredit.jsx')).toContain('formatCreditMinutes(n)');
  });
});
