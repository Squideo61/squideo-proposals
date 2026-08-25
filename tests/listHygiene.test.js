import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));

import { audienceRows, audienceSummary, clearAudienceCache } from '../api/_lib/crm/campaigns.js';
import { sendMarketingBatch } from '../api/_lib/email.js';
import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';

beforeEach(() => { resetSqlMock(); clearAudienceCache(); });

// The list as the audience query returns it: one healthy person, one who
// unsubscribed, one whose address hard-bounced.
const PEOPLE = [
  { email: 'live@acme.com', name: 'Still Here', is_customer: false, opted_in: false, unsubscribed: false },
  { email: 'gone@beta.com', name: 'Opted Out', is_customer: false, opted_in: false, unsubscribed: true,
    unsubscribed_at: '2026-08-24T12:00:00Z', suppression_reason: 'unsubscribe', suppression_scope: 'marketing' },
  { email: 'dead@gamma.com', name: 'Bounced', is_customer: false, opted_in: false, unsubscribed: true,
    unsubscribed_at: '2026-08-24T13:00:00Z', suppression_reason: 'hard_bounce', suppression_scope: 'all' },
];

function stub(rows = PEOPLE) {
  setSqlHandler((text) => {
    if (/WITH won AS/.test(text)) return rows;
    if (/SELECT id, name FROM email_campaigns/.test(text)) return [];
    return [];
  });
}

describe('the list cleans itself', () => {
  it('leaves unsubscribed and bounced addresses off every list', async () => {
    stub();
    expect((await audienceRows('everyone')).map((r) => r.email)).toEqual(['live@acme.com']);
    expect((await audienceRows('non_customers')).map((r) => r.email)).toEqual(['live@acme.com']);
  });

  it('counts them as off the list, not as part of it', async () => {
    stub();
    const counts = await audienceSummary();
    expect(counts.everyone).toBe(1);
    expect(counts.unsubscribed).toBe(1);
    expect(counts.bounced).toBe(1);
  });

  it('applies whichever email they left through — it is not per campaign', async () => {
    // An opt-out from one campaign takes them off every future one.
    stub();
    const all = await audienceRows('everyone', { includeUnsubscribed: true });
    expect(all.find((r) => r.email === 'gone@beta.com').status).toBe('unsubscribed');
  });
});

describe('the send re-checks, even mid-flight', () => {
  it('skips someone who unsubscribed AFTER the queue was built', async () => {
    // The case that matters on a send running over days: the recipient list is
    // snapshotted when the campaign starts, so anyone opting out on day one is
    // still sitting in the day-three queue. This is the check that saves it.
    setSqlHandler((text) => {
      if (/FROM email_suppressions WHERE email = ANY/.test(text)) return [{ email: 'gone@beta.com' }];
      return [];
    });
    const results = await sendMarketingBatch([
      { to: 'live@acme.com', subject: 's', html: '<p>x</p>' },
      { to: 'gone@beta.com', subject: 's', html: '<p>x</p>' },
    ]);
    expect(results[1].suppressed).toBe(true);
    expect(results[1].error).toBe('Unsubscribed');
    expect(results[1].ok).toBe(false);
  });

  it('refuses to send anything if it cannot check', async () => {
    // Fails CLOSED: not knowing who opted out is not permission to email them.
    setSqlHandler(() => { throw new Error('db down'); });
    const results = await sendMarketingBatch([{ to: 'anyone@acme.com', subject: 's', html: '<p>x</p>' }]);
    expect(results[0].ok).toBe(false);
  });

  it('does not record a database failure as an unsubscribe', async () => {
    // The lookup fails closed by blocking everyone, which is right — but the
    // caller must not read that as "they all opted out". Marking a batch
    // 'skipped' would permanently record a decision those people never made,
    // and they would never be retried.
    setSqlHandler(() => { throw new Error('db down'); });
    const [result] = await sendMarketingBatch([{ to: 'innocent@acme.com', subject: 's', html: '<p>x</p>' }]);
    expect(result.suppressed).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toBe('Could not check the unsubscribe list');
  });
});
