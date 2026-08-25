// Open/click tracking for the emails the system sends itself (the brief and
// video-guide nudge sequences).
//
// The property worth pinning is the failure path. instrumentHtml() points every
// link at /api/track/click?t=…&l=N, and that endpoint resolves the destination
// from email_tracking_links — so if the tracking row never got written, the
// instrumented copy is an email full of links that go nowhere. Sending it
// untracked is the only safe answer.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});

import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';
import { trackSystemEmail } from '../api/_lib/crm/tracking.js';

const HTML = '<p>Hello <a href="https://app.squideo.com/portal#/brief">carry on</a></p>';

beforeEach(() => { resetSqlMock(); });

describe('trackSystemEmail', () => {
  it('rewrites the links and returns the tracking row id', async () => {
    setSqlHandler((text) => (text.includes('INSERT INTO email_tracking (') ? [{ id: 42 }] : []));
    const r = await trackSystemEmail({
      html: HTML, source: 'nudge', userEmail: 'system:nudge:brief',
      subject: 'Your brief', recipient: 'someone@example.com',
    });

    expect(r.trackingId).toBe(42);
    expect(r.html).toContain('/api/track/click?t=');
    expect(r.html).toContain('/api/track/open?t=');
    // The real destination is stored, never carried in the click URL — that is
    // what keeps the endpoint from being an open redirect.
    const links = getSqlCalls().find((c) => c.text.includes('INSERT INTO email_tracking_links'));
    expect(links.values.flat()).toContain('https://app.squideo.com/portal#/brief');
  });

  it('sends the ORIGINAL html when the tracking write fails', async () => {
    setSqlHandler(() => { throw new Error('database is down'); });
    const r = await trackSystemEmail({
      html: HTML, source: 'nudge', userEmail: 'system:nudge:brief', recipient: 'someone@example.com',
    });
    expect(r.trackingId).toBeNull();
    expect(r.html).toBe(HTML);
    expect(r.html).not.toContain('/api/track/');
  });

  it('does the same when the insert reports no row', async () => {
    // ON CONFLICT DO NOTHING returns nothing. Rare (the token is random), but a
    // silently untracked send beats a broken one.
    setSqlHandler(() => []);
    const r = await trackSystemEmail({
      html: HTML, source: 'nudge', userEmail: 'system:nudge:brief', recipient: 'someone@example.com',
    });
    expect(r.trackingId).toBeNull();
    expect(r.html).toBe(HTML);
  });

  it('marks the sender as system, so no staff bell rings for a nudge open', async () => {
    setSqlHandler((text) => (text.includes('INSERT INTO email_tracking (') ? [{ id: 7 }] : []));
    await trackSystemEmail({
      html: HTML, source: 'nudge', userEmail: 'system:nudge:brief', recipient: 'someone@example.com',
    });
    const insert = getSqlCalls().find((c) => c.text.includes('INSERT INTO email_tracking ('));
    // /api/track/open skips its notification for any 'system:' sender; a real
    // address here would ring a bell for every prospect who opens a marketing
    // email, which is how people learn to ignore the bell.
    expect(insert.values.some((v) => String(v).startsWith('system:'))).toBe(true);
  });

  it('is a no-op without html or a recipient', async () => {
    setSqlHandler(() => { throw new Error('should not have run a query'); });
    expect(await trackSystemEmail({ html: '', source: 'nudge', recipient: 'a@b.c' }))
      .toEqual({ html: '', trackingId: null });
    expect(await trackSystemEmail({ html: HTML, source: 'nudge', recipient: null }))
      .toEqual({ html: HTML, trackingId: null });
  });
});
