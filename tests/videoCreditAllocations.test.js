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
function mockDb({ reserved = [], issued = 20, used = 0, video = null, workRows = [] } = {}) {
  const state = { reserved: [...reserved], work: [...workRows] };
  setSqlHandler((text) => {
    // — reads —
    if (text.includes('FROM video_credit_allocations') && text.includes('GROUP BY company_id')) {
      const total = state.reserved.filter((r) => r.status === 'reserved')
        .reduce((s, r) => s + r.minutes, 0);
      return total ? [{ company_id: 'co1', minutes: total }] : [];
    }
    if (text.includes('SELECT * FROM video_credit_allocations')) {
      return state.reserved.filter((r) => r.status !== 'released')
        .map((r) => ({ ...r, video_id: r.video_id, company_id: 'co1', deal_id: 'deal1' }));
    }
    if (text.includes('FROM video_credit_allocations a')) {
      return state.reserved
        .filter((r) => r.status === 'reserved')
        .map((r) => ({ ...r, company_id: 'co1', deal_id: 'deal1', video_title: 'Brand film', production_phase: r.phase || null, production_stage: r.stage || null }));
    }
    if (text.includes('SELECT pv.id, pv.deal_id, pv.title, d.company_id')) {
      return video ? [video] : [];
    }
    if (text.includes('WITH sub_totals AS')) {
      return [{ client_key: 'k1', credits_issued: issued, credits_used: used, credits_remaining: issued - used }];
    }
    if (text.includes('SELECT DISTINCT ps.client_key')) return [{ client_key: 'k1' }];
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
    expect(await availableForCompany(null)).toEqual({ remaining: 0, reserved: 0, available: 0 });
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
