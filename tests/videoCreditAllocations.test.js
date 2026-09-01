import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));

import {
  setVideoCreditAllocation,
  releaseVideoCreditAllocation,
  availableForCompany,
  settleSignedOffAllocations,
} from '../api/_lib/videoCreditAllocations.js';
import { companyCreditTotals } from '../api/_lib/partnerCredits.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

// Pre-assigning a client's video credit to a video that hasn't started.
//
// The whole point of the reserved state is that it must come out of what they
// can spend on something NEW without pretending the work has been done — so the
// tests here are mostly about which of the three figures each action moves.

// A stand-in database. `reserved` is the rows in video_credit_allocations;
// `issued`/`used` are what the partner ledger reports.
// `pools` describes the company's credit balances (client_key → issued/used).
// A single default pool 'k1' stands in for the common one-balance case; pass
// several to exercise a customer like Newcastle University, who holds one per
// NHS study.
function mockDb({ reserved = [], issued = 20, used = 0, video = null, workRows = [], pools = null } = {}) {
  const state = { reserved: [...reserved], work: [...workRows] };
  const poolRows = pools || [{ client_key: 'k1', client_name: 'Acme', credits_issued: issued, credits_used: used }];
  const withKeys = () => state.reserved.map((r) => ({ ...r, client_key: r.client_key ?? poolRows[0].client_key }));
  setSqlHandler((text) => {
    // — reads —
    if (text.includes('FROM video_credit_allocations') && text.includes('GROUP BY company_id')) {
      const total = state.reserved.filter((r) => r.status === 'reserved')
        .reduce((s, r) => s + r.minutes, 0);
      return total ? [{ company_id: 'co1', minutes: total }] : [];
    }
    if (text.includes("GROUP BY COALESCE(client_key, '')")) {
      const out = new Map();
      for (const r of withKeys()) {
        if (r.status !== 'reserved') continue;
        out.set(r.client_key, (out.get(r.client_key) || 0) + r.minutes);
      }
      return Array.from(out.entries()).map(([client_key, minutes]) => ({ client_key, minutes }));
    }
    if (text.includes('SELECT * FROM video_credit_allocations')) {
      return withKeys().filter((r) => r.status !== 'released')
        .map((r) => ({ ...r, company_id: 'co1', deal_id: 'deal1' }));
    }
    if (text.includes('FROM video_credit_allocations a')) {
      return withKeys()
        .filter((r) => r.status === 'reserved')
        .map((r) => ({ ...r, company_id: 'co1', deal_id: 'deal1', video_title: 'Brand film', production_phase: r.phase || null, production_stage: r.stage || null }));
    }
    if (text.includes('SELECT pv.id, pv.deal_id, pv.title, d.company_id')) {
      return video ? [video] : [];
    }
    if (text.includes('WITH sub_totals AS')) {
      return poolRows.map((p) => ({
        ...p,
        credits_remaining: (Number(p.credits_issued) || 0) - (Number(p.credits_used) || 0),
      }));
    }
    if (text.includes('SELECT DISTINCT ps.client_key')) return poolRows.map((p) => ({ client_key: p.client_key }));
    if (text.includes('SELECT id, name, xero_contact_id FROM companies')) return [{ id: 'co1', name: 'Acme', xero_contact_id: null }];
    if (text.includes('FROM project_retainers r')) return [];
    if (text.includes('FROM credit_allocations WHERE source_ref')) {
      return state.work.filter((w) => w.source_ref) .length ? [{ '?column?': 1 }] : [];
    }
    // — writes —
    if (text.includes('INSERT INTO video_credit_allocations')) {
      state.reserved.push({ id: 'vca_new', video_id: 'v1', minutes: 0, status: 'reserved' });
      return [];
    }
    if (text.includes('INSERT INTO credit_allocations')) { state.work.push({ source_ref: 'x' }); return []; }
    if (text.includes("SET status = 'spent'")) {
      for (const r of state.reserved) if (r.status === 'reserved') r.status = 'spent';
      return [{ id: 'vca1' }];
    }
    if (text.includes("SET status = 'released'")) {
      for (const r of state.reserved) if (r.status === 'reserved') r.status = 'released';
      return [];
    }
    return [];
  });
  return state;
}

const sqlText = () => getSqlCalls().map((c) => c.text);

beforeEach(() => { resetSqlMock(); });

describe('availableForCompany', () => {
  it('takes reservations out of what is free, and leaves the balance alone', async () => {
    mockDb({ issued: 20, used: 4, reserved: [{ id: 'vca1', video_id: 'v9', minutes: 6, status: 'reserved' }] });
    const bal = await availableForCompany('co1');
    expect(bal.remaining).toBe(16); // 20 bought − 4 already drawn down
    expect(bal.reserved).toBe(6);
    expect(bal.available).toBe(10); // what they can still put against something new
  });

  it('does not count a video’s own reservation against re-assigning it', async () => {
    // 6 min already held for v1. Bumping it to 8 needs 2 more free, not 8.
    mockDb({ issued: 10, used: 0, reserved: [{ id: 'vca1', video_id: 'v1', minutes: 6, status: 'reserved' }] });
    const bal = await availableForCompany('co1', { excludeVideoId: 'v1' });
    expect(bal.available).toBe(10);
  });

  it('is zero for a company with no id rather than throwing', async () => {
    expect(await availableForCompany(null)).toMatchObject({ remaining: 0, reserved: 0, available: 0 });
  });
});

describe('setVideoCreditAllocation', () => {
  const video = { id: 'v1', deal_id: 'deal1', title: 'Brand film', company_id: 'co1' };

  it('reserves minutes against a video that has not started', async () => {
    mockDb({ issued: 20, used: 0, video });
    await setVideoCreditAllocation({ videoId: 'v1', minutes: 6, user: { email: 'pm@squideo.co.uk' } });
    const insert = getSqlCalls().find((c) => c.text.includes('INSERT INTO video_credit_allocations'));
    expect(insert).toBeTruthy();
    expect(insert.values).toContain(6);
    expect(insert.text).toContain("'reserved'");
  });

  it('refuses to commit more than is free, naming what is left', async () => {
    mockDb({ issued: 10, used: 0, video, reserved: [{ id: 'vca1', video_id: 'v2', minutes: 7, status: 'reserved' }] });
    await expect(setVideoCreditAllocation({ videoId: 'v1', minutes: 5 }))
      .rejects.toThrow(/Only 3 min/);
  });

  it('refuses on a project with no customer — there is no balance to draw on', async () => {
    mockDb({ video: { ...video, company_id: null } });
    await expect(setVideoCreditAllocation({ videoId: 'v1', minutes: 2 }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('will not rewrite credit that has already been drawn down', async () => {
    mockDb({ issued: 20, video, reserved: [{ id: 'vca1', video_id: 'v1', minutes: 6, status: 'spent' }] });
    await expect(setVideoCreditAllocation({ videoId: 'v1', minutes: 2 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('treats zero minutes as handing the reservation back', async () => {
    mockDb({ issued: 20, video, reserved: [{ id: 'vca1', video_id: 'v1', minutes: 6, status: 'reserved' }] });
    await setVideoCreditAllocation({ videoId: 'v1', minutes: 0 });
    expect(sqlText().some((t) => t.includes("SET status = 'released'"))).toBe(true);
    expect(sqlText().some((t) => t.includes('INSERT INTO video_credit_allocations'))).toBe(false);
  });
});

// Newcastle University holds one credit balance per NHS study. Blending them
// into a single "credit remaining" is what made the deal page unusable for them:
// a producer on the Rivival job would be shown Establish's unspent minutes.
describe('a customer with several credit pools', () => {
  const NEWCASTLE = [
    { client_key: 'establish', client_name: 'NHS Establish Study', credits_issued: 15, credits_used: 7.5 },
    { client_key: 'rivival', client_name: 'NHS Rivival Study', credits_issued: 4, credits_used: 3 },
  ];
  const video = { id: 'v1', deal_id: 'deal1', title: 'Rivival explainer', company_id: 'co1' };

  it('reports each pool separately as well as the company total', async () => {
    mockDb({ pools: NEWCASTLE });
    const t = await companyCreditTotals('co1');
    expect(t.remaining).toBe(8.5); // 7.5 + 1, the blended number on its own
    expect(t.pools.map((p) => [p.name, p.remaining])).toEqual([
      ['NHS Establish Study', 7.5],
      ['NHS Rivival Study', 1],
    ]);
  });

  it('scopes what is free to the chosen pool, not the company', async () => {
    mockDb({ pools: NEWCASTLE });
    const bal = await availableForCompany('co1', { clientKey: 'rivival' });
    expect(bal.available).toBe(1);   // NOT 8.5
    expect(bal.clientKey).toBe('rivival');
  });

  it('refuses to spend one study’s credit on another’s video', async () => {
    mockDb({ pools: NEWCASTLE, video });
    await expect(setVideoCreditAllocation({ videoId: 'v1', minutes: 5, clientKey: 'rivival' }))
      .rejects.toThrow(/Only 1 min of credit is free on NHS Rivival Study/);
  });

  it('makes the caller choose rather than guessing which balance to raid', async () => {
    mockDb({ pools: NEWCASTLE, video });
    await expect(setVideoCreditAllocation({ videoId: 'v1', minutes: 1 }))
      .rejects.toThrow(/more than one credit balance/);
  });

  it('records the pool on the reservation, so it debits the right one later', async () => {
    mockDb({ pools: NEWCASTLE, video });
    await setVideoCreditAllocation({ videoId: 'v1', minutes: 1, clientKey: 'rivival' });
    const insert = getSqlCalls().find((c) => c.text.includes('INSERT INTO video_credit_allocations'));
    expect(insert.values).toContain('rivival');
  });

  it('settles against the pool it was reserved on', async () => {
    mockDb({
      pools: NEWCASTLE,
      reserved: [{ id: 'vca1', video_id: 'v1', minutes: 1, status: 'reserved', client_key: 'rivival', phase: 'production', stage: 'signed_off' }],
    });
    expect(await settleSignedOffAllocations({ companyId: 'co1' })).toBe(1);
    const insert = getSqlCalls().find((c) => c.text.includes('INSERT INTO credit_allocations'));
    expect(insert.values).toContain('rivival');
  });

  it('still fills the pool in when there is only one to choose', async () => {
    mockDb({ issued: 20, video });
    await setVideoCreditAllocation({ videoId: 'v1', minutes: 6 });
    const insert = getSqlCalls().find((c) => c.text.includes('INSERT INTO video_credit_allocations'));
    expect(insert.values).toContain('k1');
  });
});

describe('releaseVideoCreditAllocation', () => {
  it('only releases reserved rows — spent credit is gone and must not be re-issued', async () => {
    mockDb();
    await releaseVideoCreditAllocation('v1');
    const upd = getSqlCalls().find((c) => c.text.includes("SET status = 'released'"));
    expect(upd.text).toContain("status = 'reserved'");
  });
});

describe('settleSignedOffAllocations', () => {
  it('draws the credit down only once the video is signed off', async () => {
    mockDb({ reserved: [{ id: 'vca1', video_id: 'v1', minutes: 6, status: 'reserved', phase: 'production', stage: 'in_production' }] });
    expect(await settleSignedOffAllocations({ companyId: 'co1' })).toBe(0);
    expect(sqlText().some((t) => t.includes('INSERT INTO credit_allocations'))).toBe(false);
  });

  it('writes a partner-ledger work row when it is, keyed so a re-run cannot double-charge', async () => {
    mockDb({ reserved: [{ id: 'vca1', video_id: 'v1', minutes: 6, status: 'reserved', phase: 'production', stage: 'signed_off' }] });
    expect(await settleSignedOffAllocations({ companyId: 'co1' })).toBe(1);
    const insert = getSqlCalls().find((c) => c.text.includes('INSERT INTO credit_allocations'));
    expect(insert.text).toContain("'work'");
    expect(insert.values).toContain('vca_vca1'); // the idempotency key
    expect(insert.values).toContain('Video credit — Brand film');
  });

  it('counts a Completed-phase video as signed off too', async () => {
    mockDb({ reserved: [{ id: 'vca1', video_id: 'v1', minutes: 6, status: 'reserved', phase: 'completed', stage: 'delivered' }] });
    expect(await settleSignedOffAllocations({ companyId: 'co1' })).toBe(1);
  });
});

describe('companyCreditTotals', () => {
  it('reports reserved and available alongside the long-standing remaining', async () => {
    mockDb({ issued: 20, used: 4, reserved: [{ id: 'vca1', video_id: 'v9', minutes: 6, status: 'reserved' }] });
    const t = await companyCreditTotals('co1');
    // `remaining` must keep meaning issued − used: everything that already reads
    // it (the deal pill, the company page, the portal balance) depends on that.
    expect(t.remaining).toBe(16);
    expect(t.reserved).toBe(6);
    expect(t.available).toBe(10);
    expect(t.partner.available).toBe(10);
  });
});
