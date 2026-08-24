import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));
// A fixed token, so the test exercises the harvest logic rather than OAuth.
vi.mock('../api/_lib/crm/gmail.js', () => ({
  getFreshAccessToken: async () => 'test-token',
}));

import { harvestCandidates, importCandidates, HARVEST_PRESETS } from '../api/_lib/crm/gmailHarvest.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

const ME = 'adam@squideo.co.uk';

// A mailbox page: one real enquiry (twice), a colleague, a robot, a platform,
// our own sent mail, and someone who has since unsubscribed.
const MESSAGES = {
  m1: { from: 'Sam Taylor <sam@acme.com>', subject: 'Quote for an explainer video', date: 'Mon, 3 Mar 2025 10:00:00 +0000' },
  m2: { from: 'sam@acme.com', subject: 'Re: Quote for an explainer video', date: 'Tue, 4 Mar 2025 09:00:00 +0000' },
  m3: { from: 'Colleague <jess@squideo.co.uk>', subject: 'FW: quote', date: 'Mon, 3 Mar 2025 11:00:00 +0000' },
  m4: { from: 'no-reply@notifications.slack.com', subject: 'You have a mention', date: 'Mon, 3 Mar 2025 12:00:00 +0000' },
  m5: { from: 'jobs@linkedin.com', subject: 'Jobs for you', date: 'Mon, 3 Mar 2025 13:00:00 +0000' },
  m6: { from: 'adam@squideo.co.uk', subject: 'Re: quote', date: 'Mon, 3 Mar 2025 14:00:00 +0000' },
  m7: { from: 'Jo Blogs <jo@beta.com>', subject: 'Enquiry about a video', date: 'Wed, 5 Mar 2025 10:00:00 +0000' },
};

function stubGmail() {
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/messages?') || /\/messages\?/.test(u)) {
      return { ok: true, json: async () => ({ messages: Object.keys(MESSAGES).map((id) => ({ id })) }) };
    }
    const id = u.match(/\/messages\/([^?]+)/)?.[1];
    const m = MESSAGES[id];
    if (!m) return { ok: false, status: 404, text: async () => 'nope' };
    return {
      ok: true,
      json: async () => ({
        id, threadId: 't_' + id, internalDate: String(Date.parse(m.date)),
        payload: { headers: [
          { name: 'From', value: m.from },
          { name: 'Subject', value: m.subject },
          { name: 'Date', value: m.date },
        ] },
      }),
    };
  });
}

// jo@beta.com has unsubscribed; nobody else is known.
function stubDb() {
  setSqlHandler((text) => {
    if (/FROM email_suppressions/.test(text)) return [{ email: 'jo@beta.com' }];
    return [];
  });
}

beforeEach(() => { resetSqlMock(); stubGmail(); });

describe('the presets', () => {
  it('never search the whole mailbox', () => {
    // A preset with no constraint would be a scrape wearing a search's clothes.
    HARVEST_PRESETS.forEach((p) => {
      expect(p.query.trim()).not.toBe('');
      expect(p.query).toMatch(/subject:|to:|from:/);
    });
  });
});

describe('who a mailbox search offers up', () => {
  it('keeps the people who wrote to us and drops everything else', async () => {
    stubDb();
    const r = await harvestCandidates({ userEmail: ME, query: 'subject:quote' });
    const emails = r.candidates.map((c) => c.email).sort();
    expect(emails).toEqual(['jo@beta.com', 'sam@acme.com']);
  });

  it('drops our own team, our own sent mail, robots and platforms', async () => {
    stubDb();
    const r = await harvestCandidates({ userEmail: ME, query: 'subject:quote' });
    const emails = r.candidates.map((c) => c.email);
    expect(emails).not.toContain('jess@squideo.co.uk');          // a colleague
    expect(emails).not.toContain('adam@squideo.co.uk');          // us
    expect(emails).not.toContain('no-reply@notifications.slack.com');
    expect(emails).not.toContain('jobs@linkedin.com');           // a platform
  });

  it('carries the evidence for each person, not just the address', async () => {
    // Without the subject line and the date this is a list of strings and
    // nobody can judge whether it belongs on a marketing list.
    stubDb();
    const r = await harvestCandidates({ userEmail: ME, query: 'subject:quote' });
    const sam = r.candidates.find((c) => c.email === 'sam@acme.com');
    expect(sam.name).toBe('Sam Taylor');
    expect(sam.messages).toBe(2);
    expect(sam.lastSubject).toBe('Re: Quote for an explainer video');
    expect(sam.firstAt < sam.lastAt).toBe(true);
  });

  it('flags anyone who has already unsubscribed instead of offering them', async () => {
    stubDb();
    const r = await harvestCandidates({ userEmail: ME, query: 'subject:quote' });
    const jo = r.candidates.find((c) => c.email === 'jo@beta.com');
    expect(jo.known).toBe('unsubscribed');
    expect(r.counts.unsubscribed).toBe(1);
    expect(r.counts.new).toBe(1);
  });
});

describe('importing the ticked people', () => {
  it('refuses an address that has unsubscribed, and says why', async () => {
    stubDb();
    const r = await importCandidates({
      people: [{ email: 'jo@beta.com', name: 'Jo' }], importedBy: ME,
    });
    expect(r.added).toBe(0);
    expect(r.skipped[0]).toMatchObject({ email: 'jo@beta.com', why: 'They have unsubscribed' });
  });

  it('refuses our own addresses', async () => {
    stubDb();
    const r = await importCandidates({ people: [{ email: 'jess@squideo.co.uk' }], importedBy: ME });
    expect(r.added).toBe(0);
    expect(r.skipped[0].why).toBe('One of ours');
  });

  it('writes the evidence onto the contact it creates', async () => {
    setSqlHandler((text) => {
      if (/FROM email_suppressions/.test(text)) return [];
      if (/SELECT id, provisional FROM contacts/.test(text)) return [];
      return [];
    });
    const r = await importCandidates({
      people: [{ email: 'sam@acme.com', name: 'Sam Taylor', lastSubject: 'Quote for an explainer video', lastAt: '2025-03-04T09:00:00Z', messages: 2 }],
      importedBy: ME,
    });
    expect(r.added).toBe(1);
    const insert = getSqlCalls().find((c) => /INSERT INTO contacts/.test(c.text));
    expect(insert).toBeTruthy();
    const note = insert.values.find((v) => typeof v === 'string' && v.includes('Added from Gmail'));
    expect(note).toContain('Quote for an explainer video');
    expect(note).toContain(ME);
    // Not provisional: it has to be mailable, and we can point at why.
    expect(insert.text).toMatch(/FALSE, 'gmail_enquiry'/);
  });

  it('promotes a half-known contact rather than duplicating them', async () => {
    setSqlHandler((text) => {
      if (/FROM email_suppressions/.test(text)) return [];
      if (/SELECT id, provisional FROM contacts/.test(text)) return [{ id: 'ct_9', provisional: true }];
      return [];
    });
    const r = await importCandidates({ people: [{ email: 'pat@beta.com' }], importedBy: ME });
    expect(r.updated).toBe(1);
    expect(r.added).toBe(0);
    expect(getSqlCalls().some((c) => /INSERT INTO contacts/.test(c.text))).toBe(false);
  });

  it('leaves an existing real contact alone', async () => {
    setSqlHandler((text) => {
      if (/FROM email_suppressions/.test(text)) return [];
      if (/SELECT id, provisional FROM contacts/.test(text)) return [{ id: 'ct_1', provisional: false }];
      return [];
    });
    const r = await importCandidates({ people: [{ email: 'sam@acme.com' }], importedBy: ME });
    expect(r.added + r.updated).toBe(0);
    expect(r.skipped[0].why).toBe('Already a contact');
  });
});
