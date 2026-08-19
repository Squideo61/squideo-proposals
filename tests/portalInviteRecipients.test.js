// Who a deal's portal invite is addressed to.
//
// Written after a real one went to a secondary contact instead of the deal's
// primary: the candidate query had no ORDER BY, and the modal pre-ticked
// everyone who lacked access, so "who gets it" was decided by row order.
import { describe, it, expect, vi } from 'vitest';

// emails.js pulls in the mail helper, which reaches the db module at import.
vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});
import { pickInviteDefaults } from '../src/lib/portalInviteRecipients.js';
import { portalTeamInviteHtml } from '../api/_lib/portal/emails.js';

const rosie = { email: 'rosie@acl-uk.org', name: 'Rosie', primary: true, hasAccess: false };
const stuart = { email: 'stuart@acl-uk.org', name: 'Stuart', primary: false, hasAccess: false };
const signer = { email: 'signer@acl-uk.org', name: 'Signer', hasAccess: false };

describe('pickInviteDefaults', () => {
  it('addresses the primary contact', () => {
    expect(pickInviteDefaults([rosie, stuart]).to.email).toBe(rosie.email);
  });

  // The actual bug: the primary arriving second in the list.
  it('addresses the primary even when they are not first', () => {
    expect(pickInviteDefaults([stuart, signer, rosie]).to.email).toBe(rosie.email);
  });

  it('copies in everyone else on the deal', () => {
    expect(pickInviteDefaults([stuart, rosie, signer]).cc.sort())
      .toEqual([signer.email, stuart.email].sort());
  });

  it('never copies the addressee in on their own invite', () => {
    const { to, cc } = pickInviteDefaults([rosie, stuart]);
    expect(cc).not.toContain(to.email);
  });

  it('falls back to the first candidate when no primary is set', () => {
    expect(pickInviteDefaults([stuart, signer]).to.email).toBe(stuart.email);
  });

  it('skips anyone who already has access when choosing the addressee', () => {
    // A primary who is already in the portal needs no invite — but is still
    // worth copying in, so the rest of their team's invite isn't a surprise.
    const { to, cc } = pickInviteDefaults([{ ...rosie, hasAccess: true }, stuart]);
    expect(to.email).toBe(stuart.email);
    expect(cc).toContain(rosie.email);
  });

  it('handles a deal with nobody to invite', () => {
    expect(pickInviteDefaults([]).to).toBeNull();
    expect(pickInviteDefaults().to).toBeNull();
    expect(pickInviteDefaults([{ ...rosie, hasAccess: true }]).to).toBeNull();
  });
});

// An invite link is bound to ONE address, so a copied-in colleague who clicks
// it would create the addressee's account. The email has to say so.
describe('the CC note on the invite email', () => {
  const base = { inviterName: 'Adam', companyName: 'ACL', inviteUrl: 'https://x/portal?invite=tok' };

  it('names who is copied and whose link it is', () => {
    const html = portalTeamInviteHtml({ ...base, toName: 'Rosie', ccNames: ['Stuart'] });
    expect(html).toContain('Also copied: Stuart');
    expect(html).toContain("Rosie's account");
  });

  it('says nothing at all when nobody is copied', () => {
    const html = portalTeamInviteHtml({ ...base, toName: 'Rosie' });
    expect(html).not.toContain('Also copied');
  });

  it('still carries the invite link', () => {
    const html = portalTeamInviteHtml({ ...base, toName: 'Rosie', ccNames: ['Stuart', 'Jo'] });
    expect(html).toContain('https://x/portal?invite=tok');
    expect(html).toContain('Also copied: Stuart, Jo');
  });
});
