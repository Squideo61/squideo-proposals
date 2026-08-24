import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));
vi.mock('../api/_lib/crm/gmail.js', () => ({
  getFreshAccessToken: async () => 'test-token',
}));

import {
  HARVEST_PRESETS, isRobotAddress, parseAddress, importCandidates,
} from '../api/_lib/crm/gmailHarvest.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

const ME = 'adam@squideo.co.uk';

beforeEach(() => resetSqlMock());

describe('the search presets', () => {
  it('are all real constraints, not "everything ever"', () => {
    HARVEST_PRESETS.forEach((p) => {
      expect(p.query.trim()).not.toBe('');
      // Every preset narrows by subject, recipient, sender or folder — a
      // preset with no constraint would be a scrape wearing a search's clothes.
      expect(p.query).toMatch(/subject:|to:|from:|in:/);
    });
  });

  it('carry no date limit — a sweep goes back as far as the mailbox does', () => {
    // The bug this replaced stopped after ~500 messages, which reads as "a
    // couple of months" on a busy mailbox.
    HARVEST_PRESETS.forEach((p) => {
      expect(p.query).not.toMatch(/newer_than|older_than|after:|before:/);
    });
  });
});

describe('who counts as a person', () => {
  it('reads a name out of a From header', () => {
    expect(parseAddress('Sam Taylor <sam@acme.com>')).toEqual({ name: 'Sam Taylor', email: 'sam@acme.com' });
    expect(parseAddress('sam@acme.com')).toEqual({ name: null, email: 'sam@acme.com' });
    expect(parseAddress('"sam@acme.com" <sam@acme.com>').name).toBe(null);
  });

  it('rejects the robots', () => {
    ['no-reply@anything.com', 'noreply@x.co', 'notifications@slack.com', 'mailer-daemon@x.com',
      'bounces@x.com', 'newsletter@shop.com'].forEach((e) => {
      expect(isRobotAddress(e)).toBe(true);
    });
  });

  it('rejects the platforms that email everyone', () => {
    ['jobs@linkedin.com', 'x@facebookmail.com', 'receipts@stripe.com', 'noreply@github.com',
      'billing@subdomain.xero.com'].forEach((e) => {
      expect(isRobotAddress(e)).toBe(true);
    });
  });

  it('keeps an ordinary person at an ordinary company', () => {
    ['sam@acme.com', 'jo.blogs@some-agency.co.uk', 'hello@thatstudio.tv'].forEach((e) => {
      expect(isRobotAddress(e)).toBe(false);
    });
  });
});

describe('importing the ticked people', () => {
  it('refuses an address that has unsubscribed, and says why', () => {
    setSqlHandler((text) => (/FROM email_suppressions/.test(text) ? [{ email: 'jo@beta.com' }] : []));
    return importCandidates({ people: [{ email: 'jo@beta.com', name: 'Jo' }], importedBy: ME })
      .then((r) => {
        expect(r.added).toBe(0);
        expect(r.skipped[0]).toMatchObject({ email: 'jo@beta.com', why: 'They have unsubscribed' });
      });
  });

  it('refuses our own addresses', async () => {
    setSqlHandler(() => []);
    const r = await importCandidates({ people: [{ email: 'jess@squideo.co.uk' }], importedBy: ME });
    expect(r.added).toBe(0);
    expect(r.skipped[0].why).toBe('One of ours');
  });

  it('writes the evidence onto the contact it creates', async () => {
    setSqlHandler(() => []);
    const r = await importCandidates({
      people: [{
        email: 'sam@acme.com', name: 'Sam Taylor',
        lastSubject: 'Quote for an explainer video', lastAt: '2019-03-04T09:00:00Z', messages: 2,
      }],
      importedBy: ME,
    });
    expect(r.added).toBe(1);
    const insert = getSqlCalls().find((c) => /INSERT INTO contacts/.test(c.text));
    const note = insert.values.find((v) => typeof v === 'string' && v.includes('Added from Gmail'));
    expect(note).toContain('Quote for an explainer video');
    expect(note).toContain('2019-03-04');
    expect(note).toContain(ME);
    // Not provisional: it has to be mailable, and we can point at why.
    expect(insert.text).toMatch(/FALSE, 'gmail_enquiry'/);
  });

  it('promotes a half-known contact rather than duplicating them', async () => {
    setSqlHandler((text) => (/SELECT id, provisional FROM contacts/.test(text)
      ? [{ id: 'ct_9', provisional: true }] : []));
    const r = await importCandidates({ people: [{ email: 'pat@beta.com' }], importedBy: ME });
    expect(r.updated).toBe(1);
    expect(r.added).toBe(0);
    expect(getSqlCalls().some((c) => /INSERT INTO contacts/.test(c.text))).toBe(false);
  });

  it('leaves an existing real contact alone', async () => {
    setSqlHandler((text) => (/SELECT id, provisional FROM contacts/.test(text)
      ? [{ id: 'ct_1', provisional: false }] : []));
    const r = await importCandidates({ people: [{ email: 'sam@acme.com' }], importedBy: ME });
    expect(r.added + r.updated).toBe(0);
    expect(r.skipped[0].why).toBe('Already a contact');
  });

  it('marks the run so a re-poll does not re-offer someone just added', async () => {
    setSqlHandler(() => []);
    await importCandidates({ people: [{ email: 'new@acme.com' }], importedBy: ME, runId: 'hrv_1' });
    expect(getSqlCalls().some((c) => /UPDATE email_harvest_people SET imported_at/.test(c.text))).toBe(true);
  });
});
