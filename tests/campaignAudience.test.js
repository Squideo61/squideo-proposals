import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));

import { audienceRows, audienceSummary, consentStatus, clearAudienceCache } from '../api/_lib/crm/campaigns.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

beforeEach(() => {
  resetSqlMock();
  // The audience is cached for a minute in the running instance; each test
  // needs its own fixture rather than the previous one.
  clearAudienceCache();
});

// One of each standing, as the audience query returns them.
const PEOPLE = [
  { email: 'ask@quoted.com', name: 'Quote Asker', company_name: 'Quoted Ltd', contact_id: null,
    company_id: null, is_customer: false, src: 'quote', opted_in: true, consent_source: 'quote',
    consent_at: '2026-03-02T10:00:00Z', last_enquiry_at: '2026-03-02T10:00:00Z', unsubscribed: false },
  { email: 'sam@acme.com', name: 'Sam Taylor', company_name: 'Acme Ltd', contact_id: 'ct_1',
    company_id: 'co_1', is_customer: true, opted_in: false, unsubscribed: false },
  { email: 'lead@new.com', name: 'New Lead', company_name: 'Newco', contact_id: null,
    company_id: null, is_customer: false, opted_in: true, consent_at: '2026-08-01T09:00:00Z',
    consent_source: 'course', consent_text: 'Email me tips about video', unsubscribed: false },
  { email: 'jo@beta.com', name: 'Jo Blogs', company_name: 'Beta Ltd', contact_id: 'ct_2',
    company_id: 'co_2', is_customer: false, opted_in: false, unsubscribed: true,
    unsubscribed_at: '2026-08-10T12:00:00Z', suppression_reason: 'unsubscribe',
    suppression_source: 'campaign:camp_july', suppression_scope: 'marketing' },
  { email: 'kit@gamma.com', name: 'Kit Ray', company_name: null, contact_id: 'ct_3',
    company_id: null, is_customer: false, opted_in: false, unsubscribed: true,
    unsubscribed_at: '2026-08-02T12:00:00Z', suppression_reason: 'hard_bounce',
    suppression_source: 'resend', suppression_scope: 'all' },
];

function stubAudience(rows = PEOPLE) {
  setSqlHandler((text) => {
    if (/WITH won AS/.test(text)) return rows;
    if (/SELECT id, name FROM email_campaigns/.test(text)) {
      return [{ id: 'camp_july', name: 'July newsletter' }];
    }
    return [];
  });
}

describe('what each standing means', () => {
  it('separates an explicit tick from the soft opt-in we are relying on', () => {
    expect(consentStatus({ opted_in: true })).toBe('opted_in');
    expect(consentStatus({ opted_in: false })).toBe('soft');
  });

  it('separates an opt-out from an address that stopped working', () => {
    expect(consentStatus({ unsubscribed: true, suppression_reason: 'unsubscribe', suppression_scope: 'marketing' }))
      .toBe('unsubscribed');
    expect(consentStatus({ unsubscribed: true, suppression_reason: 'hard_bounce', suppression_scope: 'all' }))
      .toBe('bounced');
  });

  it('treats a complaint as a bounce, not as a subscriber', () => {
    expect(consentStatus({ unsubscribed: true, suppression_reason: 'complaint', suppression_scope: 'marketing' }))
      .toBe('bounced');
  });
});

describe('the mailing lists', () => {
  it('leaves anyone who has opted out off the list by default', async () => {
    stubAudience();
    const rows = await audienceRows('everyone');
    expect(rows.map((r) => r.email)).toEqual(['ask@quoted.com', 'sam@acme.com', 'lead@new.com']);
  });

  it('can show the opt-outs, clearly marked, without putting them in a send', async () => {
    stubAudience();
    const rows = await audienceRows('everyone', { includeUnsubscribed: true });
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r]));
    expect(rows).toHaveLength(5);
    expect(byEmail['jo@beta.com'].status).toBe('unsubscribed');
    expect(byEmail['kit@gamma.com'].status).toBe('bounced');
  });

  it('carries somebody who only ever asked for a quote, and says so', async () => {
    // These were invisible before: an unconverted quote request leaves either
    // no contact at all or a provisional one, and both are filtered out of the
    // contacts page the lists were built from.
    stubAudience();
    const asker = (await audienceRows('everyone')).find((r) => r.email === 'ask@quoted.com');
    expect(asker.source).toBe('quote');
    expect(asker.lastEnquiryAt).toBe('2026-03-02T10:00:00Z');
    expect(asker.isCustomer).toBe(false);
  });

  it('treats the quote form tick as the explicit consent it is', async () => {
    stubAudience();
    const asker = (await audienceRows('everyone')).find((r) => r.email === 'ask@quoted.com');
    expect(asker.status).toBe('opted_in');
    expect(asker.consentSource).toBe('quote');
  });

  it('says which email someone unsubscribed through, by name', async () => {
    // The whole point: an opt-out from ONE campaign takes them off every list,
    // so the campaign that lost them has to be nameable from anywhere.
    stubAudience();
    const rows = await audienceRows('everyone', { includeUnsubscribed: true });
    const jo = rows.find((r) => r.email === 'jo@beta.com');
    expect(jo.unsubscribedFrom).toBe('July newsletter');
    expect(jo.unsubscribedAt).toBe('2026-08-10T12:00:00Z');
  });

  it('translates the built-in unsubscribe sources into words too', async () => {
    stubAudience([{ ...PEOPLE[3], suppression_source: 'one-click' }]);
    const [row] = await audienceRows('everyone', { includeUnsubscribed: true });
    expect(row.unsubscribedFrom).toBe('a one-click unsubscribe');
  });

  it('carries the consent evidence, not just the fact of it', async () => {
    stubAudience();
    const rows = await audienceRows('everyone');
    const lead = rows.find((r) => r.email === 'lead@new.com');
    expect(lead.optedIn).toBe(true);
    expect(lead.consentSource).toBe('course');
    expect(lead.consentText).toBe('Email me tips about video');
  });

  it('applies the customer split to the mailable people only', async () => {
    stubAudience();
    expect((await audienceRows('customers')).map((r) => r.email)).toEqual(['sam@acme.com']);
    expect((await audienceRows('non_customers')).map((r) => r.email))
      .toEqual(['ask@quoted.com', 'lead@new.com']);
  });
});

describe('the counts on the cards', () => {
  it('counts what a send would reach, and shows the opt-outs separately', async () => {
    stubAudience();
    const counts = await audienceSummary();
    expect(counts).toMatchObject({
      everyone: 3,
      customers: 1,
      non_customers: 2,
      optedIn: 2,
      unsubscribed: 1,
      bounced: 1,
      suppressed: 2,
    });
  });
});

describe('the cached list', () => {
  it('answers a second time without going back to the database', async () => {
    // Every screen here derives from one expensive union query. Running it per
    // keystroke — twice, as the search endpoint used to — is what made the
    // search box look like it was doing nothing.
    stubAudience();
    await audienceRows('everyone');
    const before = getSqlCalls().filter((c) => /WITH won AS/.test(c.text)).length;
    await audienceRows('customers');
    await audienceRows('non_customers');
    await audienceSummary();
    const after = getSqlCalls().filter((c) => /WITH won AS/.test(c.text)).length;
    expect(before).toBe(1);
    expect(after).toBe(1);
  });

  it('goes back to the database when the answer decides who receives an email', async () => {
    // The browsing screens can live with a minute-old list. The send cannot.
    stubAudience();
    await audienceRows('everyone');
    await audienceRows('everyone', { fresh: true });
    expect(getSqlCalls().filter((c) => /WITH won AS/.test(c.text))).toHaveLength(2);
  });
});
