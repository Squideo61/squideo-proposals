// The demo filter is one predicate standing between pretend money and every
// Finance figure. Both directions are dangerous: leak the demo in and the
// numbers are wrong; match too eagerly and a real customer's income silently
// vanishes from the accounts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/db.js', () => ({ default: vi.fn() }));

const sql = (await import('../api/_lib/db.js')).default;
const { demoScope, invalidateDemoScope, DEMO_COMPANY_NAME } = await import('../api/_lib/crm/demoScope.js');

const DEMO_CO = 'co_demo1';
const DEMO_DEAL = 'deal_demo1';

beforeEach(() => {
  invalidateDemoScope();
  sql.mockReset();
  sql.mockResolvedValue([{ company_id: DEMO_CO, deal_id: DEMO_DEAL }]);
});

describe('demoScope', () => {
  it('collects the demo company and its deals', async () => {
    sql.mockResolvedValue([
      { company_id: DEMO_CO, deal_id: DEMO_DEAL },
      { company_id: DEMO_CO, deal_id: 'deal_demo2' },
    ]);
    const { companyIds, dealIds } = await demoScope();
    expect([...companyIds]).toEqual([DEMO_CO]);
    expect([...dealIds].sort()).toEqual(['deal_demo1', 'deal_demo2']);
  });

  it('looks the company up by the name the seeder uses', async () => {
    await demoScope();
    expect(sql.mock.calls[0].join('|')).toContain(DEMO_COMPANY_NAME);
  });

  it('handles a seeded company with no deals yet', async () => {
    sql.mockResolvedValue([{ company_id: DEMO_CO, deal_id: null }]);
    const { companyIds, dealIds, isDemo } = await demoScope();
    expect([...companyIds]).toEqual([DEMO_CO]);
    expect(dealIds.size).toBe(0);
    expect(isDemo({ companyId: DEMO_CO })).toBe(true);
  });
});

// Every finance query hands over a slightly different row shape — the whole
// point of the predicate is that the call sites don't have to care.
describe('isDemo across the row shapes finance actually produces', () => {
  it('matches a company id under either casing', async () => {
    const { isDemo } = await demoScope();
    expect(isDemo({ companyId: DEMO_CO })).toBe(true);
    expect(isDemo({ company_id: DEMO_CO })).toBe(true);
  });

  it('matches a deal id as dealId, deal_id or did', async () => {
    const { isDemo } = await demoScope();
    expect(isDemo({ dealId: DEMO_DEAL })).toBe(true);
    expect(isDemo({ deal_id: DEMO_DEAL })).toBe(true);
    expect(isDemo({ did: DEMO_DEAL })).toBe(true);
  });

  it('matches on the deal even when the company came back null', async () => {
    const { isDemo } = await demoScope();
    expect(isDemo({ company_id: null, deal_id: DEMO_DEAL })).toBe(true);
  });

  it('leaves a real customer alone', async () => {
    const { isDemo, notDemo } = await demoScope();
    const real = { companyId: 'co_kingspan', dealId: 'deal_kingspan' };
    expect(isDemo(real)).toBe(false);
    expect(notDemo(real)).toBe(true);
  });

  it('never treats an unattributed row as demo', async () => {
    // Imported sheet rows, partner fees and recurring "Other" carry no ids —
    // nothing seeded can reach those tables, so they must always be kept.
    const { isDemo } = await demoScope();
    expect(isDemo({})).toBe(false);
    expect(isDemo({ companyId: null, dealId: null })).toBe(false);
    expect(isDemo(null)).toBe(false);
    expect(isDemo(undefined)).toBe(false);
  });

  it('filters a mixed row list down to the real money', async () => {
    const { notDemo } = await demoScope();
    const rows = [
      { dealId: 'deal_kingspan', net: 1000 },
      { dealId: DEMO_DEAL, net: 2000 },
      { companyId: DEMO_CO, net: 400 },
      { net: 250 }, // partner fee — no attribution
    ];
    expect(rows.filter(notDemo).map((r) => r.net)).toEqual([1000, 250]);
  });
});

describe('when there is no demo project', () => {
  it('excludes nothing', async () => {
    sql.mockResolvedValue([]);
    const { companyIds, dealIds, isDemo } = await demoScope();
    expect(companyIds.size).toBe(0);
    expect(dealIds.size).toBe(0);
    expect(isDemo({ companyId: 'co_kingspan', dealId: 'deal_kingspan' })).toBe(false);
  });
});

// A broken lookup must never take the Finance page down, and must never start
// dropping real rows.
describe('when the lookup fails', () => {
  it('excludes nothing rather than throwing', async () => {
    sql.mockRejectedValue(new Error('relation "companies" does not exist'));
    const scope = await demoScope();
    expect(scope.isDemo({ companyId: DEMO_CO, dealId: DEMO_DEAL })).toBe(false);
    expect(scope.notDemo({ dealId: DEMO_DEAL })).toBe(true);
  });

  it('does not cache the failure', async () => {
    sql.mockRejectedValueOnce(new Error('transient'));
    expect((await demoScope()).companyIds.size).toBe(0);
    sql.mockResolvedValue([{ company_id: DEMO_CO, deal_id: DEMO_DEAL }]);
    expect((await demoScope()).isDemo({ dealId: DEMO_DEAL })).toBe(true);
  });
});

describe('caching', () => {
  it('reads the demo set once, not once per query', async () => {
    await demoScope();
    await demoScope();
    await demoScope();
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the demo is seeded or torn down', async () => {
    await demoScope();
    invalidateDemoScope();
    sql.mockResolvedValue([]);
    expect((await demoScope()).companyIds.size).toBe(0);
    expect(sql).toHaveBeenCalledTimes(2);
  });
});
