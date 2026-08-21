// A client paying the invoice we raised for their proposal used to tell nobody.
//
// The "send me an invoice instead" route takes a signed client off the card
// path: the invoice goes out through Xero, they pay it — often from the
// pay-by-card link on the invoice itself — and the money lands in Xero, never
// in `payments`. Everything downstream still worked, so nothing looked broken.
// It just happened in silence.
//
// What's pinned here is the CLAIM, because the failure mode of getting it wrong
// is worse than the bug it fixes: two callers can notice (the Xero webhook, and
// the invoices page syncing paid_amount), Xero retries its events, and the
// invoices page is opened many times a day. Without a single-winner claim the
// same payment announces itself indefinitely.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});
vi.mock('../api/_lib/email.js', () => ({ APP_URL: 'https://app.squideo.com', sendMail: async () => {} }));

const sent = [];
vi.mock('../api/_lib/notifications.js', () => ({
  sendNotification: async (key, opts) => { sent.push({ key, ...opts }); },
}));
vi.mock('../api/_lib/dealStage.js', () => ({
  dealIdForProposal: async () => 'deal-1',
}));

import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';
import { notifyProposalInvoicePaid } from '../api/_lib/crm/proposalInvoicePaid.js';

// `claimable` models the paid_notified_at column: the conditional UPDATE
// returns a row the first time and nothing afterwards, exactly like Postgres.
function stub({ claimable = true, proposalId = 'prop-1', alreadyRecorded = 0 } = {}) {
  let taken = !claimable;
  const claims = [];
  setSqlHandler((text) => {
    if (text.includes('ALTER TABLE proposal_billing')) return [];
    if (text.includes('UPDATE proposal_billing') && text.includes('paid_notified_at')) {
      claims.push(text);
      if (taken) return [];
      taken = true;
      return [{ proposal_id: proposalId }];
    }
    // "Has anyone already recorded this money by another route?"
    if (text.includes('FROM manual_payments WHERE proposal_id')) {
      return [{ n: alreadyRecorded }];
    }
    if (text.includes('FROM proposals WHERE id')) {
      return [{ data: { proposalTitle: 'CareConnect launch film', contactBusinessName: 'Northwind Care' } }];
    }
    return [];
  });
  return { claims };
}

beforeEach(() => { resetSqlMock(); sent.length = 0; });

describe('notifyProposalInvoicePaid', () => {
  it('announces a paid proposal invoice', async () => {
    stub();
    const ok = await notifyProposalInvoicePaid({
      xeroInvoiceId: 'xero-1', invoiceNumber: 'INV-0042', amount: 1500,
    });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    // Same key as a card payment: from the money side this IS the client
    // paying, and splitting it by which button they pressed would mean the £
    // bell reports some payments and not others.
    expect(sent[0].key).toBe('payment.received');
    expect(sent[0].subject).toContain('CareConnect launch film');
    expect(sent[0].inApp.body).toContain('INV-0042');
    expect(sent[0].inApp.body).toContain('£1500.00');
    expect(sent[0].inApp.link).toBe('#/deal/deal-1');
  });

  it('only ever announces once, however many callers notice', async () => {
    stub();
    const first = await notifyProposalInvoicePaid({ xeroInvoiceId: 'xero-1' });
    // A Xero retry, then someone opening the invoices page, then another retry.
    const rest = await Promise.all([
      notifyProposalInvoicePaid({ xeroInvoiceId: 'xero-1' }),
      notifyProposalInvoicePaid({ xeroInvoiceId: 'xero-1' }),
      notifyProposalInvoicePaid({ xeroInvoiceId: 'xero-1' }),
    ]);
    expect(first).toBe(true);
    expect(rest).toEqual([false, false, false]);
    expect(sent).toHaveLength(1);
  });

  it('stays quiet for an invoice that is not a proposal-billing one', async () => {
    // No row claimed — a manual invoice isn't in proposal_billing, and it has
    // its own paid alert (invoice.paid_manual). Two would be one too many.
    stub({ claimable: false });
    expect(await notifyProposalInvoicePaid({ xeroInvoiceId: 'manual-1' })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('quotes no figure rather than a wrong one when Xero gives no total', async () => {
    stub();
    await notifyProposalInvoicePaid({ xeroInvoiceId: 'xero-1', invoiceNumber: 'INV-9' });
    expect(sent[0].inApp.body).toBe('Northwind Care · INV-9 paid via Xero');
    // The point: no figure at all beats a figure we'd be guessing at.
    expect(sent[0].inApp.body).not.toContain('£');
    expect(sent[0].text).not.toContain('£');
  });

  it('records an old payment without announcing it', async () => {
    // The sync discovers things out of order. A payment from months ago is not
    // news, and announcing a batch of them the first time this code runs is how
    // a new alert earns itself a mute. The claim is still taken, so it can't
    // resurface later pretending to be fresh.
    const { claims } = stub();
    const ok = await notifyProposalInvoicePaid({
      xeroInvoiceId: 'xero-old', invoiceNumber: 'INV-0001', paidAt: '2025-11-02',
    });
    expect(ok).toBe(false);
    expect(claims).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('announces a recent-but-not-instant payment with the date up front', async () => {
    stub();
    const paidAt = new Date(Date.now() - 8 * 86400000).toISOString();
    await notifyProposalInvoicePaid({ xeroInvoiceId: 'xero-1', invoiceNumber: 'INV-7', paidAt });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('Invoice paid on');
    expect(sent[0].inApp.body).toContain('only just picked this up');
  });

  it('stays quiet when the money is already recorded another way', async () => {
    // A colleague records the payment by hand the moment the client says it's
    // gone out; days later Xero confirms the invoice. One payment, two
    // discoveries — and a second "the client paid" alert reads as a second
    // payment, which is worse than noise.
    const { claims } = stub({ alreadyRecorded: 1 });
    const ok = await notifyProposalInvoicePaid({ xeroInvoiceId: 'xero-1', invoiceNumber: 'INV-6131' });
    expect(ok).toBe(false);
    // Claimed regardless, so it can't fire on the next sync either.
    expect(claims).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('names the client, since every proposal has the same title', async () => {
    stub();
    await notifyProposalInvoicePaid({ xeroInvoiceId: 'xero-1', invoiceNumber: 'INV-6131' });
    // "Explainer Video Proposal" on its own identifies nothing — two alerts a
    // day apart can name the same thing and be about different clients.
    expect(sent[0].subject).toContain('Northwind Care');
    expect(sent[0].inApp.body).toContain('Northwind Care');
  });

  it('does nothing without an invoice id', async () => {
    const { claims } = stub();
    expect(await notifyProposalInvoicePaid({ xeroInvoiceId: null })).toBe(false);
    expect(claims).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
