import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));

import { threadsRoute } from '../api/_lib/crm/threads.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

beforeEach(() => resetSqlMock());

// Minimal res double — records the status/body the route replied with.
function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => res;
  return res;
}

const USER = { email: 'adam@squideo.co.uk' };

// Every SELECT the link/unlink path makes resolves to "found"; writes return [].
function stubRows() {
  setSqlHandler((text) => {
    if (/FROM deals WHERE id/.test(text)) return [{ id: 'deal_1', title: 'Mitsubishi' }];
    if (/FROM email_threads WHERE gmail_thread_id/.test(text)) return [{ gmail_thread_id: 'thr_1' }];
    if (/SELECT gmail_message_id FROM email_messages/.test(text)) return [{ gmail_message_id: 'msg_1' }];
    return [];
  });
}

const queries = () => getSqlCalls().map(c => c.text);

describe('removing one email from a deal', () => {
  it('blocks the message so a linked thread cannot pull it back in', async () => {
    stubRows();
    const res = makeRes();
    await threadsRoute(
      { method: 'DELETE', query: { dealId: 'deal_1', scope: 'message', gmailMessageId: 'msg_1' } },
      res, 'thr_1', 'link', USER,
    );

    expect(res.statusCode).toBe(200);
    const sqls = queries();
    // The message-scope link goes...
    expect(sqls.some(t => /DELETE FROM email_message_deals/.test(t))).toBe(true);
    // ...and the removal is remembered, which is what actually hides it when the
    // whole conversation is attached to the deal.
    expect(sqls.some(t => /INSERT INTO email_message_deal_blocks/.test(t))).toBe(true);
    // A single message must never take the whole conversation off the deal.
    expect(sqls.some(t => /DELETE FROM email_thread_deals/.test(t))).toBe(false);
    expect(sqls.some(t => /INSERT INTO email_thread_deal_blocks/.test(t))).toBe(false);
  });

  it('re-linking that message clears the block', async () => {
    stubRows();
    const res = makeRes();
    await threadsRoute(
      { method: 'POST', body: { dealId: 'deal_1', scope: 'message', gmailMessageId: 'msg_1' } },
      res, 'thr_1', 'link', USER,
    );

    expect(res.statusCode).toBe(200);
    const sqls = queries();
    expect(sqls.some(t => /DELETE FROM email_message_deal_blocks/.test(t))).toBe(true);
    expect(sqls.some(t => /INSERT INTO email_message_deals/.test(t))).toBe(true);
  });

  it('re-linking the whole thread brings individually removed messages back', async () => {
    stubRows();
    const res = makeRes();
    await threadsRoute(
      { method: 'POST', body: { dealId: 'deal_1', scope: 'thread' } },
      res, 'thr_1', 'link', USER,
    );

    expect(res.statusCode).toBe(200);
    const sqls = queries();
    expect(sqls.some(t => /DELETE FROM email_message_deal_blocks/.test(t))).toBe(true);
    expect(sqls.some(t => /DELETE FROM email_thread_deal_blocks/.test(t))).toBe(true);
  });

  it('unlinking the whole conversation still blocks at thread level', async () => {
    stubRows();
    const res = makeRes();
    await threadsRoute(
      { method: 'DELETE', query: { dealId: 'deal_1', scope: 'thread' } },
      res, 'thr_1', 'link', USER,
    );

    expect(res.statusCode).toBe(200);
    const sqls = queries();
    expect(sqls.some(t => /INSERT INTO email_thread_deal_blocks/.test(t))).toBe(true);
    expect(sqls.some(t => /INSERT INTO email_message_deal_blocks/.test(t))).toBe(false);
  });
});
