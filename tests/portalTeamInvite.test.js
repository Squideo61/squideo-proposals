// The CRM-sent portal invite ("CRM portal invite" on the deal page) is the one
// invite Squideo sends itself rather than handing to the composer, so its
// wording is confirmed in a draft first and passed through to the template.
// Two things must hold whatever gets typed: the invite link survives, and
// nothing typed into the message can inject markup into a client's inbox.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});

const { portalTeamInviteHtml } = await import('../api/_lib/portal/emails.js');

const URL = 'https://app.squideo.com/portal?invite=abc123_XYZ-token';
const base = { inviterName: 'Adam Shelton', companyName: 'Membership Plus', inviteUrl: URL };

describe('portalTeamInviteHtml', () => {
  it('uses the standard copy when no wording was confirmed', () => {
    const html = portalTeamInviteHtml(base);
    expect(html).toContain("Adam Shelton invited you to Membership Plus&#39;s Squideo portal");
    expect(html).toContain("Track your team&#39;s video projects");
    expect(html).toContain(URL);
  });

  it('takes the confirmed subject as the heading and the confirmed message as the body', () => {
    const html = portalTeamInviteHtml({
      ...base,
      heading: 'Your Membership Plus video is underway',
      message: 'Hi Finlay, your portal is ready.',
    });
    expect(html).toContain('Your Membership Plus video is underway');
    expect(html).toContain('Hi Finlay, your portal is ready.');
    expect(html).not.toContain("Track your team&#39;s video projects");
  });

  it('keeps the link and its button whatever the wording', () => {
    const html = portalTeamInviteHtml({ ...base, heading: 'Anything', message: 'At all' });
    expect(html).toContain('Join the portal');
    expect(html.match(new RegExp(URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length).toBeGreaterThanOrEqual(2);
  });

  it('escapes markup typed into the message', () => {
    const html = portalTeamInviteHtml({
      ...base,
      message: '<script>alert(1)</script> & "quoted" <b>bold</b>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<b>bold</b>');
  });

  it('turns blank lines into paragraphs and single newlines into breaks', () => {
    const html = portalTeamInviteHtml({ ...base, message: 'First para.\n\nSecond para.\nSame para, new line.' });
    expect(html).toContain('>First para.</p>');
    expect(html).toContain('Second para.<br>Same para, new line.');
  });

  it('falls back to the standard copy on whitespace-only wording', () => {
    const html = portalTeamInviteHtml({ ...base, heading: '   ', message: '\n  \n' });
    expect(html).toContain("Adam Shelton invited you to Membership Plus&#39;s Squideo portal");
    expect(html).toContain("Track your team&#39;s video projects");
  });
});
