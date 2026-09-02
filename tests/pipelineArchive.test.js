// Paid and Lost never empty themselves, so they were burying the live end of
// the pipeline behind years of finished business. Those deals now drop off the
// board (still in the CRM, one click away in the archive).
//
// What's pinned here is the boundary, because getting it wrong loses work
// rather than tidying it: only terminal stages clear, a deal is judged on time
// in its stage, and — the one that matters most — money still in the air keeps
// a deal on the board no matter how old it is. A "Pending invoice" deal from
// last quarter is unfinished admin, and this list is where anyone looks for it.
import { describe, it, expect } from 'vitest';
import {
  archiveReason,
  isArchived,
  splitArchived,
  describeArchive,
  daysInStage,
  CLEAR_AFTER_DAYS,
} from '../src/lib/pipelineArchive.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const SETTLED = { isPo: false, poReceivedAt: null, invoiced: true, depositPaid: false, paidInFull: true, committed: true };
// An old, finished, fully-settled deal — the baseline the exemptions vary from.
const settledOld = (over = {}) => ({ id: 'd', stage: 'paid', stageChangedAt: daysAgo(90), saleStatus: SETTLED, ...over });

describe('archiveReason', () => {
  it('leaves live stages alone however old they are', () => {
    for (const stage of ['lead', 'responded', 'proposal_sent', 'viewed', 'interested', 'signed', 'long_term']) {
      expect(archiveReason(settledOld({ stage }))).toBe(null);
    }
  });

  it('clears settled paid and lost deals past the cut-off', () => {
    expect(archiveReason(settledOld({ stage: 'paid' }))).toBe('age');
    expect(archiveReason(settledOld({ stage: 'lost', saleStatus: null }))).toBe('age');
  });

  it('keeps recent finished deals on the board', () => {
    expect(archiveReason(settledOld({ stageChangedAt: daysAgo(CLEAR_AFTER_DAYS - 1) }))).toBe(null);
    expect(archiveReason(settledOld({ stageChangedAt: daysAgo(CLEAR_AFTER_DAYS) }))).toBe(null);
  });

  it('ages on time in stage, not on when the deal was created', () => {
    // Won last week off a lead we opened two years ago — that's live business.
    expect(archiveReason(settledOld({ createdAt: daysAgo(700), stageChangedAt: daysAgo(5) }))).toBe(null);
  });

  it('falls back to createdAt when no stage change was recorded', () => {
    expect(archiveReason(settledOld({ stage: 'lost', saleStatus: null, stageChangedAt: null, createdAt: daysAgo(500) }))).toBe('age');
  });

  it('keeps an undated deal on the board rather than hiding it', () => {
    expect(archiveReason({ id: 'x', stage: 'paid', saleStatus: SETTLED })).toBe(null);
  });
});

describe('money still outstanding exempts a deal from the age clear-out', () => {
  const outstanding = {
    'not invoiced yet':   { ...SETTLED, invoiced: false, paidInFull: false },
    'unpaid PO balance':  { ...SETTLED, isPo: true, poReceivedAt: daysAgo(80), poNumber: 'PO-9', invoiced: true, paidInFull: false },
    'invoiced, unpaid':   { ...SETTLED, invoiced: true, paidInFull: false },
    'deposit paid only':  { ...SETTLED, invoiced: false, depositPaid: true, paidInFull: false },
    'PO not yet raised':  { ...SETTLED, isPo: true, poReceivedAt: null, invoiced: false, paidInFull: false },
  };
  for (const [label, saleStatus] of Object.entries(outstanding)) {
    it(`keeps a ${label} deal on the board at ${CLEAR_AFTER_DAYS * 3} days`, () => {
      expect(archiveReason(settledOld({ saleStatus }))).toBe(null);
    });
  }

  it('still clears one that is settled in full against a received PO', () => {
    expect(archiveReason(settledOld({ saleStatus: { ...SETTLED, isPo: true, poReceivedAt: daysAgo(80), poNumber: 'PO-9' } }))).toBe('age');
  });

  // "Pending invoice" is where a signed deal lands when the CRM holds no
  // invoice row for it — which is also every deal invoiced straight in Xero and
  // everything from before the CRM did invoicing. Left as evidence of money
  // owed, that pill pinned years of legacy deals to the board permanently.
  it('does not treat a bare "pending invoice" as money owed when nothing is committed', () => {
    const noRecord = { ...SETTLED, invoiced: false, paidInFull: false, committed: false };
    expect(archiveReason(settledOld({ saleStatus: noRecord }))).toBe('age');
  });

  it('still exempts an uninvoiced deal once a signed total exists to invoice', () => {
    const owed = { ...SETTLED, invoiced: false, paidInFull: false, committed: true };
    expect(archiveReason(settledOld({ saleStatus: owed }))).toBe(null);
  });

  it('keeps trusting the later pills without a committed total', () => {
    // Invoiced-but-unpaid and deposit-paid are positive statements about money,
    // not fallbacks, so they hold the deal on the board on their own.
    for (const saleStatus of [
      { ...SETTLED, paidInFull: false, committed: false },
      { ...SETTLED, invoiced: false, depositPaid: true, paidInFull: false, committed: false },
      { ...SETTLED, isPo: true, poReceivedAt: null, invoiced: false, paidInFull: false, committed: false },
    ]) {
      expect(archiveReason(settledOld({ saleStatus }))).toBe(null);
    }
  });
});

describe('the manual overrides beat the age rule both ways', () => {
  it('archives a deal by hand whatever its stage, age or money state', () => {
    const fresh = { id: 'f', stage: 'lead', stageChangedAt: daysAgo(1), pipelineArchivedAt: daysAgo(0) };
    expect(archiveReason(fresh)).toBe('manual');
    // Even one that still owes us money, if someone explicitly put it away.
    expect(archiveReason(settledOld({ saleStatus: { ...SETTLED, invoiced: false, paidInFull: false }, pipelineArchivedAt: daysAgo(0) }))).toBe('manual');
  });

  it('keeps a restored deal on the board despite the age rule', () => {
    expect(archiveReason(settledOld({ pipelineRestoredAt: daysAgo(1) }))).toBe(null);
  });

  it('re-archiving a restored deal wins over the restore', () => {
    expect(archiveReason(settledOld({ pipelineRestoredAt: daysAgo(10), pipelineArchivedAt: daysAgo(1) }))).toBe('manual');
  });
});

describe('splitArchived', () => {
  it('splits a stage into what is on the board and what is put away, keeping order', () => {
    const live = settledOld({ id: 'live', stageChangedAt: daysAgo(2) });
    const old1 = settledOld({ id: 'old1' });
    const old2 = settledOld({ id: 'old2', pipelineArchivedAt: daysAgo(1) });
    const { current, archived } = splitArchived([old1, live, old2]);
    expect(current.map(d => d.id)).toEqual(['live']);
    expect(archived.map(d => d.id)).toEqual(['old1', 'old2']);
  });
});

describe('describeArchive', () => {
  it('says how long a cleared deal sat in its stage', () => {
    expect(describeArchive(settledOld({ stageChangedAt: daysAgo(65) }), 'Paid')).toBe('Paid · 65 days');
  });

  it('names a hand-archived deal as such', () => {
    expect(describeArchive(settledOld({ pipelineArchivedAt: '2026-09-02T10:00:00Z' }), 'Paid')).toBe('Archived by hand · 2 Sept 2026');
  });

  it('says nothing about a deal that is on the board', () => {
    expect(describeArchive(settledOld({ stageChangedAt: daysAgo(1) }), 'Paid')).toBe(null);
    expect(isArchived(settledOld({ stageChangedAt: daysAgo(1) }))).toBe(false);
  });
});

describe('daysInStage', () => {
  it('counts whole days since the stage change', () => {
    expect(daysInStage({ stageChangedAt: daysAgo(3) })).toBe(3);
  });
  it('is null with nothing to measure from', () => {
    expect(daysInStage({})).toBe(null);
  });
});
