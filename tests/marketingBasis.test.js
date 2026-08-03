// Marketing counting basis. The case that prompted this: a lead that arrived in
// July and signed in August was invisible in August, because every figure was
// credited to the lead's month. The 'event' basis counts each milestone in the
// period it happened; 'lead' keeps the old cohort behaviour for true ROAS.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';

vi.mock('../api/_lib/db.js', () => ({ default: (...a) => import('./helpers/mockDb.js').then((m) => m.sqlMock(...a)) }));
vi.mock('../api/_lib/userRoles.js', () => ({ getRole: async () => ({ key: 'admin' }) }));
vi.mock('../api/_lib/permissions.js', () => ({ hasPermission: () => true }));
vi.mock('../api/_lib/email.js', () => ({ APP_URL: 'https://app.squideo.com' }));
vi.mock('../api/_lib/leadAttribution.js', () => ({ ensureLeadAttribution: async () => {} }));
vi.mock('../api/_lib/crm/googleAds.js', () => ({ adsConfigured: () => false, ensureAdSpend: async () => {}, runAdSpendSync: async () => {} }));
vi.mock('../api/_lib/crm/googleSearch.js', () => ({ gscConfigured: () => false, runGscSync: async () => {}, searchReport: async () => ({}) }));
vi.mock('../api/_lib/crm/googleAnalytics.js', () => ({ ga4Configured: () => false, runGa4Sync: async () => {}, trafficReport: async () => ({}) }));
vi.mock('../api/_lib/crm/marketingSyncStatus.js', () => ({ getSyncStatus: async () => null, recordSyncStatus: async () => {} }));
vi.mock('../api/_lib/crm/deals.js', () => ({
  // effectiveValue/valueSource is all analytics needs off annotateDeals.
  annotateDeals: async (rows) => rows.map((r) => ({ ...r, effectiveValue: r.value, valueSource: 'signed' })),
}));

const { analyticsRoute } = await import('../api/_lib/crm/analytics.js');

// One paid-search lead: enquired 29 July, signed 3 August for £1,800.
const LEAD = {
  id: 'qr1', status: 'qualified', deal_id: 'd1',
  created_at: '2026-07-29T09:00:00Z', reviewed_at: '2026-07-30T09:00:00Z',
  attr_channel: 'paid_search', attr_source: 'google', attr_medium: 'cpc',
  attr_campaign: '1958815188', attr_campaign_id: '1958815188', attr_keyword: 'explainer video', attr_term: null,
};

function installDb({ leads = [LEAD], signedAt = '2026-08-03T11:00:00Z', proposalAt = '2026-07-30T10:00:00Z', dealStageAt } = {}) {
  setSqlHandler((text, values) => {
    if (text.includes('marketing_leads_from DATE')) return [];
    if (text.startsWith('\n    UPDATE settings')) return [];
    if (text.includes('SELECT marketing_leads_from')) return [{ marketing_leads_from: '2026-06-13' }];
    if (text.includes('FROM quote_requests')) {
      // Emulate the WHERE bounds so the test really exercises how far back the
      // route scans — that window is the whole point of the event basis.
      const [lo, hi] = values;
      return leads.filter((l) => {
        const t = new Date(l.created_at).getTime();
        return t >= new Date(lo).getTime() && t < new Date(hi).getTime();
      });
    }
    if (text.includes('FROM deals')) return [{ id: 'd1', stage: 'signed', value: 1800, stage_changed_at: dealStageAt === undefined ? signedAt : dealStageAt }];
    if (text.includes('FROM signatures')) return signedAt ? [{ did: 'd1', signed_at: signedAt }] : [];
    if (text.includes('FROM proposals')) return proposalAt ? [{ did: 'd1', created_at: proposalAt }] : [];
    if (text.includes('FROM deal_events')) return [];
    return [];
  });
}

async function report({ from, to, basis }) {
  const url = `/api/crm/analytics/reports/channel?from=${from}&to=${to}` + (basis ? `&basis=${basis}` : '');
  let payload = null;
  const res = { setHeader() {}, status() { return this; }, json(b) { payload = b; return this; } };
  await analyticsRoute({ method: 'GET', url }, res, 'reports', 'channel', { role: 'admin' });
  return payload;
}

const AUG = { from: '2026-08-01', to: '2026-08-31' };
const JUL = { from: '2026-07-01', to: '2026-07-31' };

describe('marketing reports counting basis', () => {
  beforeEach(() => { resetSqlMock(); installDb(); });

  it('counts an August signature in August, though the lead came in July', async () => {
    const r = await report({ ...AUG, basis: 'event' });
    expect(r.basis).toBe('event');
    expect(r.totals.sales).toBe(1);
    expect(r.totals.revenue).toBe(1800);
    // The lead itself, and its July proposal, stay in July.
    expect(r.totals.leads).toBe(0);
    expect(r.totals.proposalsSent).toBe(0);
    // Attribution still comes from the originating lead.
    expect(r.rows.map((x) => x.key)).toEqual(['paid_search']);
    expect(r.rows[0].revenue).toBe(1800);
  });

  it('defaults to the event basis when no basis is given', async () => {
    const r = await report(AUG);
    expect(r.basis).toBe('event');
    expect(r.totals.sales).toBe(1);
  });

  it('keeps the cohort view on the lead basis — August shows nothing', async () => {
    const r = await report({ ...AUG, basis: 'lead' });
    expect(r.totals.sales).toBe(0);
    expect(r.totals.revenue).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it('credits the sale to July on the lead basis, alongside the lead', async () => {
    const r = await report({ ...JUL, basis: 'lead' });
    expect(r.totals.leads).toBe(1);
    expect(r.totals.qualified).toBe(1);
    expect(r.totals.proposalsSent).toBe(1);
    expect(r.totals.sales).toBe(1);
    expect(r.totals.revenue).toBe(1800);
  });

  it('splits the journey across months on the event basis', async () => {
    const jul = await report({ ...JUL, basis: 'event' });
    expect(jul.totals.leads).toBe(1);
    expect(jul.totals.qualified).toBe(1);   // reviewed 30 July
    expect(jul.totals.proposalsSent).toBe(1); // proposal 30 July
    expect(jul.totals.sales).toBe(0);       // but it signed in August
    const aug = await report({ ...AUG, basis: 'event' });
    expect(aug.totals.sales).toBe(1);
    // Totals reconcile: the sale is counted once, in exactly one month.
    expect(jul.totals.sales + aug.totals.sales).toBe(1);
  });

  it('never double-counts a lead that both arrives and signs in the period', async () => {
    installDb({
      leads: [{ ...LEAD, created_at: '2026-08-04T09:00:00Z', reviewed_at: '2026-08-05T09:00:00Z' }],
      signedAt: '2026-08-20T11:00:00Z', proposalAt: '2026-08-06T10:00:00Z',
    });
    const r = await report({ ...AUG, basis: 'event' });
    expect(r.totals).toMatchObject({ leads: 1, qualified: 1, proposalsSent: 1, sales: 1, revenue: 1800 });
    expect(r.rows).toHaveLength(1);
  });

  it('falls back to the lead date when a sale has no recorded sale date', async () => {
    // No signature and no stage_changed_at → the July lead date carries it.
    installDb({ signedAt: null, proposalAt: null, dealStageAt: null });
    const jul = await report({ ...JUL, basis: 'event' });
    const aug = await report({ ...AUG, basis: 'event' });
    expect(jul.totals.sales).toBe(1);
    expect(aug.totals.sales).toBe(0);
  });

  it('excludes leads from before the marketing cutoff on either basis', async () => {
    installDb({ leads: [{ ...LEAD, created_at: '2026-05-02T09:00:00Z' }] });
    const r = await report({ ...AUG, basis: 'event' });
    expect(r.totals.sales).toBe(0);
  });
});
