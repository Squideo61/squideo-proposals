import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));

import { isValidEmail, repairEmail, assessEmail } from '../api/_lib/crm/emailAddress.js';
import { parseQuoteRequestEmail, normaliseLabels } from '../api/_lib/crm/quoteEmailParser.js';

const OURS = ['squideo.co.uk', 'squideo.com'];

describe('what counts as a usable address', () => {
  it('accepts ordinary ones', () => {
    ['sam@acme.com', 'jo.blogs@some-agency.co.uk', 'a+tag@x.io', 'hello@thatstudio.tv']
      .forEach((e) => expect(isValidEmail(e)).toBe(true));
  });

  it('rejects the obviously broken', () => {
    ['', 'not-an-email', 'sam@acme', 'sam@@acme.com', 'sam @acme.com', 'sam@acme..com']
      .forEach((e) => expect(isValidEmail(e)).toBe(false));
  });

  it('rejects a label word welded to the domain', () => {
    // The bug this whole file exists for: a naive pattern is perfectly happy
    // with "comphone" as a top-level domain, and every one of these bounces.
    expect(isValidEmail('absemailolmazatheartist11@gmail.comphone')).toBe(false);
    expect(isValidEmail('sam@acme.co.ukphone')).toBe(false);
    expect(isValidEmail('sam@acme.comname')).toBe(false);
  });

  it('does not reject a real address that happens to contain a label word', () => {
    expect(isValidEmail('myemail@acme.com')).toBe(true);
    expect(isValidEmail('sam@mail.company.com')).toBe(true);
    expect(isValidEmail('phone@acme.com')).toBe(true);
  });
});

describe('repairing what the parser mangled', () => {
  it('recovers the real address from the reported case', () => {
    expect(repairEmail('absemailolmazatheartist11@gmail.comphone'))
      .toBe('olmazatheartist11@gmail.com');
  });

  it('handles the same damage on a co.uk', () => {
    expect(repairEmail('emailsam@acme.co.ukphone')).toBe('sam@acme.co.uk');
  });

  it('leaves a good address exactly as it is', () => {
    expect(repairEmail('olmazatheartist11@gmail.com')).toBe('olmazatheartist11@gmail.com');
  });

  it('refuses to guess when there is no confident answer', () => {
    // Better one address left for a human than a stranger receiving somebody
    // else's marketing.
    expect(repairEmail('complete nonsense')).toBe(null);
    expect(repairEmail('@nothing.com')).toBe(null);
    expect(repairEmail('sam@')).toBe(null);
  });

  it('reports what it did, so a sweep can be checked', () => {
    expect(assessEmail('sam@acme.com')).toMatchObject({ verdict: 'ok' });
    expect(assessEmail('absemailolmazatheartist11@gmail.comphone')).toMatchObject({
      verdict: 'repaired', email: 'olmazatheartist11@gmail.com',
    });
    expect(assessEmail('nonsense')).toMatchObject({ verdict: 'invalid' });
  });
});

describe('the parser that caused it', () => {
  // The whole enquiry on one line, which is what an html table body flattens to
  // when nothing emits a line break.
  const COLLAPSED = 'New Quote Request Received! CONTACT INFORMATION: 👤 Name: Olma Zat '
    + '📧 Email: olmazatheartist11@gmail.com 📱 Phone: 07700 900123 🏢 Company: Olma Art '
    + 'Opt In? false PROJECT DETAILS: 📋 Description: Need an explainer '
    + '⏰ Timeline: ASAP 💰 Budget: 2k 📅 Submitted: 2026-02-18T14:00:09.532Z';

  it('puts a run-together enquiry back onto separate lines', () => {
    expect(normaliseLabels('Name: Sam Email: sam@x.com Phone: 123'))
      .toBe('Name: Sam\nEmail: sam@x.com\nPhone: 123');
  });

  it('reads a collapsed body correctly instead of gluing the labels on', () => {
    const p = parseQuoteRequestEmail({ subject: 'Quote Request', body: COLLAPSED, internalDomains: OURS });
    expect(p.email).toBe('olmazatheartist11@gmail.com');
    expect(p.name).toBe('Olma Zat');
    expect(p.phone).toBe('07700 900123');
    expect(p.company).toBe('Olma Art');
    expect(p.budget).toBe('2k');
  });

  it('never returns an address that would bounce', () => {
    // Even if everything else fails, what comes out has to be sendable.
    const p = parseQuoteRequestEmail({
      subject: 'Quote Request',
      body: 'CONTACT INFORMATION: Email: absemailolmazatheartist11@gmail.comphone Phone: 123',
      internalDomains: OURS,
    });
    expect(p.email).toBe('olmazatheartist11@gmail.com');
    expect(isValidEmail(p.email)).toBe(true);
  });

  it('gives up rather than inventing an address it cannot validate', () => {
    expect(parseQuoteRequestEmail({
      subject: 'Quote Request', body: 'CONTACT INFORMATION: Email: total nonsense here',
      internalDomains: OURS,
    })).toBe(null);
  });
});
