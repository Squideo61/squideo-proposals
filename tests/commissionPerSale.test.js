// Per-sale commission. The bands are cumulative across the month, so what a
// sale earns depends on what came before it — which makes the interesting cases
// order, the sale that straddles the Band A cap, and the arithmetic property
// that matters most on a finance screen: the rows must add up to the header.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', () => ({ default: vi.fn() }));
vi.mock('../api/_lib/crm/deals.js', () => ({ computeProposalTotalExVat: vi.fn() }));
vi.mock('../api/_lib/crm/signedSale.js', () => ({ EXCLUDED_IMPORT_DEAL_IDS: new Set() }));
vi.mock('../api/_lib/userRoles.js', () => ({ getRole: vi.fn() }));
vi.mock('../api/_lib/permissions.js', () => ({ hasPermission: vi.fn() }));

const { commissionPerSale, computeCommission } = await import('../api/_lib/crm/commission.js');

const CFG = { bandARate: 0.05, bandACap: 5000, bandBRate: 0.02 };
const sale = (date, amount) => ({
  date, amount, company: 'X', title: 'Y', dealId: 'd', kind: 'deposit', key: `d:${date}`,
});
const sum = (rows, key) => Number(rows.reduce((s, r) => s + r[key], 0).toFixed(2));

describe('commissionPerSale', () => {
  it('pays the Band A rate while the month is under the cap', () => {
    const rows = commissionPerSale([sale('2026-07-08', 625), sale('2026-07-27', 1745)], CFG);
    expect(rows.map((r) => r.commission)).toEqual([31.25, 87.25]);
    expect(rows.every((r) => r.rate === 0.05)).toBe(true);
  });

  it('fills Band A oldest-first, whatever order the sales arrive in', () => {
    const later = commissionPerSale([sale('2026-07-20', 4000), sale('2026-07-02', 4000)], CFG);
    // The 2 July sale is wholly inside the cap; the 20 July one straddles it.
    expect(later[0].date).toBe('2026-07-02');
    expect(later[0].commission).toBe(200);   // 4,000 @ 5%
    expect(later[1].bandA).toBe(50);         // the remaining 1,000 of the cap @ 5%
    expect(later[1].bandB).toBe(60);         // 3,000 above it @ 2%
  });

  it('reports a blended rate for the sale that straddles the cap', () => {
    const [, straddler] = commissionPerSale([sale('2026-07-01', 4000), sale('2026-07-10', 4000)], CFG);
    expect(straddler.rate).toBeCloseTo(110 / 4000, 6); // between 2% and 5%
    expect(straddler.rate).toBeGreaterThan(CFG.bandBRate);
    expect(straddler.rate).toBeLessThan(CFG.bandARate);
  });

  it('pays only Band B once the cap is used up', () => {
    const rows = commissionPerSale([sale('2026-07-01', 5000), sale('2026-07-09', 2000)], CFG);
    expect(rows[1]).toMatchObject({ bandA: 0, bandB: 40, commission: 40, rate: 0.02 });
  });

  it('adds up to the month total exactly, including where rounding bites', () => {
    // Thirds of a penny per sale — rounding each one on its own would drift.
    const items = Array.from({ length: 7 }, (_, i) => sale(`2026-07-0${i + 1}`, 333.33));
    const rows = commissionPerSale(items, CFG);
    const month = computeCommission(items.reduce((s, i2) => s + i2.amount, 0), CFG);
    expect(sum(rows, 'commission')).toBe(month.total);
    expect(sum(rows, 'bandA')).toBe(month.bandA);
    expect(sum(rows, 'bandB')).toBe(month.bandB);
  });

  it('adds up across the cap boundary too', () => {
    const items = [sale('2026-07-01', 1234.56), sale('2026-07-05', 4321.99), sale('2026-07-11', 987.65)];
    const rows = commissionPerSale(items, CFG);
    const month = computeCommission(items.reduce((s, i2) => s + i2.amount, 0), CFG);
    expect(sum(rows, 'commission')).toBe(month.total);
    expect(sum(rows, 'net')).toBe(month.qualifying);
  });

  it('carries the sale through untouched and never earns on nothing', () => {
    const [row] = commissionPerSale([{ ...sale('2026-07-01', 0), company: 'Acme', kind: 'extra' }], CFG);
    expect(row).toMatchObject({ company: 'Acme', kind: 'extra', commission: 0, rate: 0 });
  });

  it('keeps each sale’s key — it is what a disqualification is stored against', () => {
    const rows = commissionPerSale([sale('2026-07-02', 100), sale('2026-07-09', 200)], CFG);
    expect(rows.map((r) => r.key)).toEqual(['d:2026-07-02', 'd:2026-07-09']);
  });
});

// The pending forecast prices money that hasn't landed yet as though it landed
// on top of the month as it stands — so it has to start the ladder part-used,
// not at Band A, or it would promise someone a rate they can no longer earn.
describe('commissionPerSale with a part-used month (pending forecast)', () => {
  it('charges the marginal rate, not a fresh Band A', () => {
    // £3,625 already counted → only £1,375 of the 5% band is left.
    const [row] = commissionPerSale([sale('2026-08-01', 3000)], CFG, 3625);
    expect(row.bandA).toBe(68.75);   // 1,375 @ 5%
    expect(row.bandB).toBe(32.5);    // 1,625 @ 2%
    expect(row.commission).toBe(101.25);
  });

  it('pays Band B only once the month has already used the cap', () => {
    const [row] = commissionPerSale([sale('2026-08-01', 2000)], CFG, 5000);
    expect(row).toMatchObject({ bandA: 0, bandB: 40, commission: 40, rate: 0.02 });
  });

  it('is the same answer as banding the whole month at once', () => {
    const earned = [sale('2026-08-02', 3625)];
    const pending = [sale('2026-08-20', 3000), sale('2026-08-25', 900)];
    const forecast = commissionPerSale(pending, CFG, 3625);
    const together = commissionPerSale([...earned, ...pending], CFG);
    const sumOf = (rows) => sum(rows, 'commission');
    expect(sumOf(forecast)).toBe(Number((sumOf(together) - together[0].commission).toFixed(2)));
  });

  it('an untouched month behaves exactly as before', () => {
    const items = [sale('2026-08-01', 4000), sale('2026-08-09', 4000)];
    expect(commissionPerSale(items, CFG, 0)).toEqual(commissionPerSale(items, CFG));
  });
});
