// A content-credit client buys a pot of minutes up front — "15 minutes of
// animated training content" — and every video comes out of it. That pot lived
// only on the deal page in the CRM, so the person who had just paid for fifteen
// minutes had no way to see how many were left without emailing us to ask.
//
// This is the lookup that puts it in their portal. The thing worth pinning is
// the ROUND TRIPS: the dashboard draws every project a client has at once, and
// the obvious implementation (the existing single-deal helper, in a loop) is
// two queries per project against an HTTP driver that charges a round trip for
// each one.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});

import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';
import { dealCreditProjects } from '../api/_lib/crm/retainers.js';

beforeEach(() => resetSqlMock());

const row = (deal_id, allocation_amount, used) => ({
  id: `ret-${deal_id}`, deal_id, allocation_amount, used,
});

describe('dealCreditProjects', () => {
  it('reads every deal in one query, not two per deal', async () => {
    setSqlHandler(() => [row('d1', 15, 0), row('d2', 10, 4)]);
    const out = await dealCreditProjects(['d1', 'd2', 'd3']);
    expect(getSqlCalls()).toHaveLength(1);
    expect(out.get('d1')).toMatchObject({ allocationAmount: 15, used: 0, remaining: 15 });
    expect(out.get('d2')).toMatchObject({ allocationAmount: 10, used: 4, remaining: 6 });
  });

  it('leaves a fixed-price project out entirely', async () => {
    // The portal renders nothing for a missing entry. A zeroed row would put a
    // "0 minutes left" line on a project nobody bought credit for.
    setSqlHandler(() => [row('d1', 15, 0)]);
    const out = await dealCreditProjects(['d1', 'd-fixed-price']);
    expect(out.has('d-fixed-price')).toBe(false);
    expect(out.get('d-fixed-price')).toBeUndefined();
  });

  it('counts only the live credit pool', async () => {
    setSqlHandler(() => []);
    await dealCreditProjects(['d1']);
    const [{ text }] = getSqlCalls();
    // Not an hours-based retainer, and not one that has been closed.
    expect(text).toMatch(/allocation_type = 'credits'/);
    expect(text).toMatch(/COALESCE\(r\.status, 'active'\) = 'active'/);
    // A deal can carry more than one pool historically; the oldest is the one
    // videos are drawn against, the same pick getDealCreditProject makes.
    expect(text).toMatch(/DISTINCT ON \(r\.deal_id\)/);
    expect(text).toMatch(/ORDER BY r\.deal_id, r\.created_at ASC/);
  });

  it('asks nothing when there are no deals to ask about', async () => {
    expect((await dealCreditProjects([])).size).toBe(0);
    expect(getSqlCalls()).toHaveLength(0);
  });

  it('survives a pool with nothing logged against it yet', async () => {
    // COALESCE(SUM(...), 0) does this in SQL, but a null slipping through must
    // not turn the client's remaining balance into NaN.
    setSqlHandler(() => [{ id: 'r1', deal_id: 'd1', allocation_amount: 15, used: null }]);
    expect((await dealCreditProjects(['d1'])).get('d1')).toMatchObject({ used: 0, remaining: 15 });
  });

  it('reports an overspent pool honestly rather than clamping at zero', async () => {
    // Producers do log more than was bought — that's a conversation to have,
    // and hiding it behind a floor of zero means nobody has it.
    setSqlHandler(() => [row('d1', 10, 12)]);
    expect((await dealCreditProjects(['d1'])).get('d1').remaining).toBe(-2);
  });

  it('costs the credit line, never the page, when the query fails', async () => {
    setSqlHandler(() => Promise.reject(new Error('relation "project_retainers" does not exist')));
    expect((await dealCreditProjects(['d1'])).size).toBe(0);
  });
});
