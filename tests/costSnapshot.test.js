import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));
// costSnapshot imports the live compute helpers at module load; stub them so the
// test doesn't pull in @vercel/blob / the Neon API client (crmCostGbpByMonth
// never calls them — it only reads the snapshot table).
vi.mock('../api/blob-usage.js', () => ({ compute: vi.fn() }));
vi.mock('../api/neon-usage.js', () => ({ compute: vi.fn() }));

import { crmCostGbpByMonth, USD_TO_GBP } from '../api/_lib/crm/costSnapshot.js';
import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';

beforeEach(() => resetSqlMock());

describe('crmCostGbpByMonth', () => {
  const round2 = (n) => Number((Number(n) || 0).toFixed(2));

  it('converts each month’s USD snapshot total to GBP', async () => {
    setSqlHandler((text) => {
      if (text.includes('CREATE TABLE')) return [];
      if (text.includes('FROM crm_cost_snapshots')) {
        return [{ month: '2026-05', total_usd: 20 }, { month: '2026-06', total_usd: 30 }];
      }
      return [];
    });
    const out = await crmCostGbpByMonth(['2026-05', '2026-06'], '2026-07');
    expect(out['2026-05']).toBe(round2(20 * USD_TO_GBP));
    expect(out['2026-06']).toBe(round2(30 * USD_TO_GBP));
  });

  it('returns £0 for a past month with no snapshot (snapshots only accrue forward)', async () => {
    setSqlHandler((text) => {
      if (text.includes('CREATE TABLE')) return [];
      if (text.includes('FROM crm_cost_snapshots')) return [{ month: '2026-06', total_usd: 30 }];
      return [];
    });
    const out = await crmCostGbpByMonth(['2026-01', '2026-06'], '2026-07');
    expect(out['2026-01']).toBe(0);
    expect(out['2026-06']).toBe(round2(30 * USD_TO_GBP));
  });

  it('carries the latest snapshot forward for the current month when its row is missing', async () => {
    setSqlHandler((text) => {
      if (text.includes('CREATE TABLE')) return [];
      if (text.includes('FROM crm_cost_snapshots')) return [{ month: '2026-06', total_usd: 30 }];
      return [];
    });
    // 2026-07 is the current month and has no row → carry forward June's $30.
    const out = await crmCostGbpByMonth(['2026-07'], '2026-07');
    expect(out['2026-07']).toBe(round2(30 * USD_TO_GBP));
  });

  it('uses the current month’s own row when present (not the carry-forward)', async () => {
    setSqlHandler((text) => {
      if (text.includes('CREATE TABLE')) return [];
      if (text.includes('FROM crm_cost_snapshots')) {
        return [{ month: '2026-06', total_usd: 30 }, { month: '2026-07', total_usd: 12 }];
      }
      return [];
    });
    const out = await crmCostGbpByMonth(['2026-07'], '2026-07');
    expect(out['2026-07']).toBe(round2(12 * USD_TO_GBP));
  });
});
