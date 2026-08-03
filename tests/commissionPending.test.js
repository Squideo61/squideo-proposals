// Pending commission — the money a salesperson is owed but hasn't earned yet.
// The cases that matter are the ones where a wrong answer would either promise
// someone money they'll never get (a lost deal, a disqualified sale) or quietly
// count the same sale twice (a paid extra that's also inside a pending base).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sqlMock, setSqlHandler, resetSqlMock } from './helpers/mockDb.js';

vi.mock('../api/_lib/db.js', () => ({ default: sqlMock }));
vi.mock('../api/_lib/crm/deals.js', () => ({
  computeProposalTotalExVat: (prop) => Number(prop?.net) || 0,
}));
vi.mock('../api/_lib/crm/signedSale.js', () => ({ EXCLUDED_IMPORT_DEAL_IDS: new Set() }));
vi.mock('../api/_lib/crm/demoScope.js', () => ({ demoScope: async () => ({ isDemo: () => false }) }));
vi.mock('../api/_lib/userRoles.js', () => ({ getRole: vi.fn() }));
vi.mock('../api/_lib/permissions.js', () => ({ hasPermission: vi.fn() }));

const { commissionForMonth } = await import('../api/_lib/crm/commission.js');

const OWNER = 'callum@squideo.co.uk';
const now = new Date();
const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
// Mid-month, so a UTC/local wobble can't push the earned sale into another month.
const inThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15));
const monthsAgo = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 10));

const signed = (id, net, extra = {}) => ({
  deal_id: id, owner_email: OWNER, title: `${id} video`, company: `${id} Ltd`, stage: 'signed',
  signed_at: monthsAgo(3), sig_data: {}, prop_data: { net }, ...extra,
});

// Everything the report reads, keyed by a unique fragment of each statement.
function install({ sigs = [], paid = [], extras = [], invoiced = [], disqualified = [] } = {}) {
  setSqlHandler((text) => {
    if (text.includes('CREATE TABLE')) return [];
    if (text.includes('INSERT INTO commission_config')) return [];
    if (text.includes('FROM commission_config')) return [{ band_a_rate: 0.05, band_a_cap: 5000, band_b_rate: 0.02 }];
    if (text.includes('FROM commission_members')) {
      return [{ email: OWNER, enabled: true, effective_from: '2020-01', name: 'Callum Major' }];
    }
    if (text.includes('FROM signatures')) return sigs;
    if (text.includes('MIN(paid_at)')) return paid;
    if (text.includes('FROM deal_extras')) return extras;
    if (text.includes('FROM manual_invoices')) return invoiced;
    if (text.includes('FROM commission_disqualifications')) return disqualified;
    if (text.includes('FROM users')) return [];
    throw new Error('unexpected query: ' + text.slice(0, 120));
  });
}

const member = (report) => report.members.find((m) => m.email === OWNER);

beforeEach(() => resetSqlMock());

describe('pending commission', () => {
  it('prices unpaid signed work at the rate it would earn on top of this month', async () => {
    install({
      sigs: [signed('paid-deal', 3625), signed('po-deal', 3000)],
      paid: [{ deal_id: 'paid-deal', first_paid: inThisMonth }],
      invoiced: [{ deal_id: 'po-deal', invoiced_at: monthsAgo(1) }],
    });
    const m = member(await commissionForMonth(thisMonth));

    // Earned: £3,625 @ 5% = £181.25, leaving £1,375 of the Band A cap.
    expect(m.commission.total).toBe(181.25);
    // Pending: the £3,000 PO fills the rest of Band A, the remainder at 2%.
    expect(m.pending.net).toBe(3000);
    expect(m.pending.commission).toMatchObject({ bandA: 68.75, bandB: 32.5, total: 101.25 });
    expect(m.pending.basisNet).toBe(3625);
    expect(m.pending.items).toHaveLength(1);
    expect(m.pending.items[0]).toMatchObject({ dealId: 'po-deal', kind: 'deposit', net: 3000 });
    expect(m.pending.items[0].invoicedAt).toBeTruthy();
  });

  it('tags PO-route work as such — that is the whole reason it waits', async () => {
    install({ sigs: [signed('po-deal', 4000, { sig_data: { paymentOption: 'po' } })] });
    const m = member(await commissionForMonth(thisMonth));
    expect(m.pending.items[0].kind).toBe('po_paid');
    expect(m.pending.items[0].key).toBe('po-deal:po_paid');
  });

  it('never forecasts a lost deal', async () => {
    install({ sigs: [signed('gone', 8000, { stage: 'lost' })] });
    const m = member(await commissionForMonth(thisMonth));
    expect(m.pending.items).toEqual([]);
    expect(m.pending.commission.total).toBe(0);
  });

  it('never forecasts a sale already taken off the plan', async () => {
    install({
      sigs: [signed('off-plan', 8000)],
      disqualified: [{ event_key: 'off-plan:deposit', reason: 'inherited account', disqualified_by: 'adam@squideo.co.uk' }],
    });
    const m = member(await commissionForMonth(thisMonth));
    expect(m.pending.items).toEqual([]);
  });

  it('forecasts an unpaid extra added after the deal was paid, but not a paid one', async () => {
    install({
      sigs: [signed('live', 2000)],
      paid: [{ deal_id: 'live', first_paid: monthsAgo(2) }],
      extras: [
        { extra_id: 'x1', deal_id: 'live', amount: 500, status: 'invoiced', created_at: monthsAgo(1), paid_at: null, owner_email: OWNER, title: 'live video', company: 'live Ltd' },
        { extra_id: 'x2', deal_id: 'live', amount: 300, status: 'paid', created_at: monthsAgo(1), paid_at: monthsAgo(1), owner_email: OWNER, title: 'live video', company: 'live Ltd' },
        { extra_id: 'x3', deal_id: 'live', amount: 900, status: 'quoted', created_at: monthsAgo(1), paid_at: null, owner_email: OWNER, title: 'live video', company: 'live Ltd' },
      ],
    });
    const m = member(await commissionForMonth(thisMonth));
    // Only the invoiced-and-unpaid one: the paid extra has already been earned,
    // and a quote isn't a sale.
    expect(m.pending.items.map((i) => i.key)).toEqual(['live:extra:x1']);
    expect(m.pending.net).toBe(500);
  });

  it('folds a not-yet-paid deal’s unpaid extras into its pending base, once', async () => {
    install({
      sigs: [signed('waiting', 2000)],
      extras: [
        { extra_id: 'x1', deal_id: 'waiting', amount: 400, status: 'pending', created_at: monthsAgo(2), paid_at: null, owner_email: OWNER, title: 'w', company: 'W Ltd' },
        // Already recognised on its own when it was paid — counting it again in
        // the base would forecast money the member has been paid for.
        { extra_id: 'x2', deal_id: 'waiting', amount: 600, status: 'paid', created_at: monthsAgo(2), paid_at: monthsAgo(1), owner_email: OWNER, title: 'w', company: 'W Ltd' },
      ],
    });
    const m = member(await commissionForMonth(thisMonth));
    expect(m.pending.items).toHaveLength(1);
    expect(m.pending.net).toBe(2400);
  });

  it('quotes the same figure whichever month is on screen', async () => {
    install({
      sigs: [signed('paid-deal', 3625), signed('po-deal', 3000)],
      paid: [{ deal_id: 'paid-deal', first_paid: inThisMonth }],
    });
    const nowReport = member(await commissionForMonth(thisMonth));
    const backThen = member(await commissionForMonth('2026-01'));
    expect(backThen.commission.total).toBe(0);            // nothing was earned then
    expect(backThen.pending).toEqual(nowReport.pending);  // but what's coming is what's coming
  });

  it('forecasts nothing for a paused member', async () => {
    setSqlHandler((text) => {
      if (text.includes('CREATE TABLE') || text.includes('INSERT INTO commission_config')) return [];
      if (text.includes('FROM commission_config')) return [{ band_a_rate: 0.05, band_a_cap: 5000, band_b_rate: 0.02 }];
      if (text.includes('FROM commission_members')) return [{ email: OWNER, enabled: false, effective_from: '2020-01', name: 'Callum Major' }];
      if (text.includes('FROM signatures')) return [signed('po-deal', 3000)];
      if (text.includes('MIN(paid_at)') || text.includes('FROM deal_extras') || text.includes('FROM manual_invoices')) return [];
      if (text.includes('FROM commission_disqualifications')) return [];
      throw new Error('unexpected query: ' + text.slice(0, 120));
    });
    const m = member(await commissionForMonth(thisMonth));
    expect(m.pending.items).toEqual([]);
    expect(m.pending.commission.total).toBe(0);
  });
});
