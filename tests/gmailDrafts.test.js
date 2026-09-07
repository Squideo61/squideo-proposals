import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));

// The real module pulls in @vercel/blob and the whole send pipeline; the sweep
// only wants a token off it.
vi.mock('../api/_lib/crm/gmail.js', () => ({
  getFreshAccessToken: vi.fn(async () => 'tok'),
}));

import { ingestMessage } from '../api/_lib/gmailSync.js';
import { gmailPruneDrafts } from '../api/_lib/crm/gmailDraftPrune.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

// Gmail writes a new message on every draft autosave and deletes the one
// before it, so a thread the CRM had ingested naively showed four "OUT" emails
// where the client had received one. Drafts must never be filed as sent mail,
// and the ones already filed have to come back out.

const res = () => {
  const out = { code: null, body: null };
  return {
    out,
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
    end() { return this; },
  };
};

const gmailMessage = (labelIds) => ({
  id: 'm1',
  threadId: 'th1',
  labelIds,
  internalDate: '1750000000000',
  snippet: 'Hi',
  payload: {
    headers: [
      { name: 'From', value: 'me@squideo.co.uk' },
      { name: 'To', value: 'client@example.com' },
      { name: 'Subject', value: 'Script and Text Direction Files' },
    ],
    body: { data: '' },
  },
});

beforeEach(() => resetSqlMock());
afterEach(() => { vi.unstubAllGlobals(); });

describe('ingestMessage draft guard', () => {
  const sqlStub = () => setSqlHandler((text) => {
    if (text.includes('FROM gmail_accounts')) return [{ gmail_address: 'me@squideo.co.uk' }];
    return [];
  });

  it('refuses a DRAFT and clears any row an earlier deploy filed', async () => {
    sqlStub();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => gmailMessage(['DRAFT']),
    })));

    const out = await ingestMessage({ userEmail: 'me@squideo.co.uk', accessToken: 't', messageId: 'm1' });

    expect(out.skipped).toBe('draft');
    const texts = getSqlCalls().map((c) => c.text);
    expect(texts.some((t) => t.includes('DELETE FROM email_messages'))).toBe(true);
    expect(texts.some((t) => t.includes('INSERT INTO email_messages'))).toBe(false);
  });

  it('still ingests a genuinely sent message', async () => {
    sqlStub();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => gmailMessage(['SENT']),
    })));

    await ingestMessage({ userEmail: 'me@squideo.co.uk', accessToken: 't', messageId: 'm1' });

    const texts = getSqlCalls().map((c) => c.text);
    expect(texts.some((t) => t.includes('INSERT INTO email_messages'))).toBe(true);
    expect(texts.some((t) => t.includes('DELETE FROM email_messages'))).toBe(false);
  });
});

describe('gmailPruneDrafts', () => {
  // Stored outbound rows for one thread; the Gmail thread lookup decides which
  // of them were ever really sent.
  const stored = [
    { gmail_message_id: 'auto1', subject: 'Script', sent_at: '2026-08-20T14:44:00Z' },
    { gmail_message_id: 'auto2', subject: 'Script', sent_at: '2026-08-20T14:50:00Z' },
    { gmail_message_id: 'live',  subject: 'Script', sent_at: '2026-08-20T15:47:00Z' },
    { gmail_message_id: 'sent',  subject: 'Script', sent_at: '2026-08-20T15:47:00Z' },
  ];

  const withThread = (liveMessages) => {
    setSqlHandler((text) => {
      if (text.includes('FROM email_threads')) {
        return [{ gmail_thread_id: 'th1', user_email: 'me@squideo.co.uk' }];
      }
      if (text.includes('FROM email_messages')) return stored;
      return [];
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ messages: liveMessages }),
    })));
  };

  const run = async (body) => {
    const r = res();
    await gmailPruneDrafts({ method: 'POST', body }, r, { email: 'adam@squideo.co.uk', role: 'admin' });
    return r.out.body;
  };

  it('reports the deleted autosaves and the live draft, and leaves the real send', async () => {
    withThread([
      { id: 'sent', labelIds: ['SENT'] },
      { id: 'live', labelIds: ['DRAFT'] },
    ]);

    const body = await run({});
    expect(body.draftsFound).toBe(3);
    expect(body.draftsRemoved).toBe(0); // report-only without apply
    expect(body.sample.map((s) => s.gmailMessageId).sort()).toEqual(['auto1', 'auto2', 'live']);
    expect(body.sample.find((s) => s.gmailMessageId === 'live').reason).toBe('labelled DRAFT');
    expect(body.sample.find((s) => s.gmailMessageId === 'auto1').reason)
      .toBe('not in the Gmail thread');
  });

  it('deletes them only when applied', async () => {
    withThread([{ id: 'sent', labelIds: ['SENT'] }, { id: 'live', labelIds: ['DRAFT'] }]);

    const body = await run({ apply: true });
    expect(body.draftsRemoved).toBe(3);
    const del = getSqlCalls().find((c) => c.text.includes('DELETE FROM email_messages'));
    expect(del.values[0].sort()).toEqual(['auto1', 'auto2', 'live']);
  });

  it('removes nothing when the thread lookup fails', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM email_threads')) {
        return [{ gmail_thread_id: 'th1', user_email: 'me@squideo.co.uk' }];
      }
      if (text.includes('FROM email_messages')) return stored;
      return [];
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

    const body = await run({ apply: true });
    expect(body.threadsSkipped).toBe(1);
    expect(body.draftsFound).toBe(0);
    expect(getSqlCalls().some((c) => c.text.includes('DELETE FROM email_messages'))).toBe(false);
  });

  it('treats an empty thread reply as "learned nothing", not "all stale"', async () => {
    withThread([]);

    const body = await run({ apply: true });
    expect(body.threadsSkipped).toBe(1);
    expect(body.draftsRemoved).toBe(0);
    expect(getSqlCalls().some((c) => c.text.includes('DELETE FROM email_messages'))).toBe(false);
  });

  it('leaves a clean thread alone', async () => {
    setSqlHandler((text) => {
      if (text.includes('FROM email_threads')) {
        return [{ gmail_thread_id: 'th1', user_email: 'me@squideo.co.uk' }];
      }
      if (text.includes('FROM email_messages')) return [stored[3]];
      return [];
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ messages: [{ id: 'sent', labelIds: ['SENT'] }] }),
    })));

    const body = await run({ apply: true });
    expect(body.threadsChecked).toBe(1);
    expect(body.draftsFound).toBe(0);
    expect(body.draftsRemoved).toBe(0);
  });
});
