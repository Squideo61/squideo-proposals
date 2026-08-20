// "Adam Shelton just paid £2,000.00 (full payment) for Explainer Video
// Proposal - Iona Hartshorn."
//
// Adam didn't pay it. Adam recorded it; the client paid it. The template had
// one slot for a name and the manual-payment path filled it with whoever was at
// the keyboard, so the email read as a colleague buying his own proposal — and
// it went to the whole workspace.
//
// Who paid and who told us are different facts. Pinned separately here, because
// the failure is silent: the email is well-formed, plausible, and wrong.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});

import { paidHtml } from '../api/_lib/email.js';

const PROPOSAL = {
  proposalTitle: 'Explainer Video Proposal',
  clientName: 'Iona Hartshorn',
  contactBusinessName: 'SafeLives',
};

describe('a card payment', () => {
  it('credits the client Stripe told us about', () => {
    const html = paidHtml({
      proposal: PROPOSAL,
      signerName: 'Iona Hartshorn',
      signerEmail: 'iona@safelives.example',
      amount: 2000,
      paymentType: 'full',
      paidAt: '2026-08-20T07:23:11Z',
      link: 'https://app.squideo.com/?proposal=p1',
    });
    expect(html).toContain('Iona Hartshorn');
    expect(html).toContain('paid');
    // No colleague involved, so no line claiming one entered it.
    expect(html).not.toContain('Recorded by');
  });
});

describe('a payment entered by hand', () => {
  const recorded = (over = {}) => paidHtml({
    proposal: PROPOSAL,
    signerName: 'Iona Hartshorn',
    signerEmail: null,
    amount: 2000,
    paymentType: 'full',
    paidAt: '2026-08-20T07:23:11Z',
    link: 'https://app.squideo.com/?proposal=p1',
    recordedBy: 'Adam Shelton',
    paymentMethod: 'bacs',
    ...over,
  });

  it('never says the colleague paid', () => {
    const html = recorded();
    expect(html).not.toMatch(/Adam Shelton[^<]*paid/);
  });

  it('credits the client and records the colleague separately', () => {
    const html = recorded();
    // The client is the subject of the sentence…
    expect(html).toContain('Iona Hartshorn paid');
    // …and the colleague is a detail in the table, not the headline.
    expect(html).toContain('Recorded by');
    expect(html).toContain('Adam Shelton');
    expect(html).toContain('BACS');
  });

  it('falls back to the proposal when there is no signature to name', () => {
    // Better to name the client from the proposal than to put the staff name
    // on it, and better still to name nobody than to guess.
    const html = recorded({ signerName: null });
    expect(html).toContain('Iona Hartshorn');
    expect(html).not.toMatch(/Adam Shelton[^<]*paid/);
    expect(html).toContain('Recorded by');
  });

  it('says the money arrived without naming anyone when nobody is known', () => {
    const html = recorded({
      signerName: null,
      proposal: { proposalTitle: 'Explainer Video Proposal' },
    });
    expect(html).toContain('received');
    expect(html).not.toMatch(/Adam Shelton[^<]*paid/);
  });

  it('escapes a name rather than trusting it', () => {
    const html = recorded({ signerName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
  });
});
