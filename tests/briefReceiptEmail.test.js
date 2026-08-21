// The receipt a client gets when they finalise a brief.
//
// It carries the "set a password" link, which is the only place that offer
// reaches someone who closed the tab after finalising — and the only path that
// VERIFIES their address, since a self-serve signup never proved it. Two ways
// it can go wrong quietly:
//
//  1. The setup block renders for someone who already has a password, and a
//     client is invited to set one they've had for a year.
//  2. It stops rendering at all, and the offer silently only ever exists on a
//     screen most people have already navigated away from.
import { describe, it, expect, vi } from 'vitest';

// emails.js reaches api/_lib/email.js for APP_URL, which opens a database
// handle at import time. Nothing below sends anything.
vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});

import { portalBriefReceivedHtml } from '../api/_lib/portal/emails.js';

const BASE = {
  clientName: 'Alex Morgan',
  projectTitle: 'Northwind Ordering launch film',
  briefUrl: 'https://app.squideo.com/portal#/brief/cb_1',
};

describe('the brief receipt', () => {
  it('says we have it, and links to it', () => {
    const html = portalBriefReceivedHtml(BASE);
    expect(html).toContain("We've got your brief");
    expect(html).toContain('Northwind Ordering launch film');
    expect(html).toContain('https://app.squideo.com/portal#/brief/cb_1');
    expect(html).toContain('Alex Morgan');
  });

  it('offers a password only when there is a link to set one', () => {
    // No setupUrl means the account already has a password. Offering anyway is
    // the version of this that makes us look like we don't know our own users.
    const without = portalBriefReceivedHtml(BASE);
    expect(without).not.toContain('Set a password');
    expect(without).not.toContain('Getting back in');

    const with_ = portalBriefReceivedHtml({ ...BASE, setupUrl: 'https://app.squideo.com/portal?reset=abc&new=1' });
    expect(with_).toContain('Set a password');
    expect(with_).toContain('reset=abc&amp;new=1');
  });

  it('leads with the brief, not the password', () => {
    // The receipt is the point; the password is a footnote under a rule. If the
    // order ever flips, this reads as a signup email for something they have
    // already done.
    const html = portalBriefReceivedHtml({ ...BASE, setupUrl: 'https://x/y?reset=t&new=1' });
    expect(html.indexOf('View your brief')).toBeLessThan(html.indexOf('Set a password'));
  });

  it('survives a brief with no title and no name', () => {
    const html = portalBriefReceivedHtml({ briefUrl: 'https://x/y' });
    expect(html).toContain("We've got your brief");
    expect(html).toContain('Thanks');
    // No stray "for undefined" or empty <strong>.
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });

  it('escapes what the client typed', () => {
    const html = portalBriefReceivedHtml({
      ...BASE,
      clientName: 'Tom & Jerry <b>',
      projectTitle: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Tom &amp; Jerry &lt;b&gt;');
  });
});
