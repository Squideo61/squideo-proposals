// Paid and Lost never empty themselves, so they were burying the live end of
// the pipeline behind years of finished business. Anything that's sat in one of
// those stages for over a month now drops off the board (still in the CRM —
// the rows are one click away). What's pinned here is the boundary: only the
// terminal stages are ever cleared, and a deal is judged on how long it's been
// in its stage, not on when it was created.
import { describe, it, expect } from 'vitest';
import { splitOlderDeals, CLEAR_AFTER_DAYS } from '../src/components/crm/PipelineView.jsx';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

describe('splitOlderDeals', () => {
  it('leaves live stages completely alone', () => {
    const deals = [{ id: 'a', stageChangedAt: daysAgo(400) }, { id: 'b', stageChangedAt: daysAgo(1) }];
    for (const stage of ['lead', 'responded', 'proposal_sent', 'viewed', 'interested', 'signed', 'long_term']) {
      const { current, older } = splitOlderDeals(stage, deals);
      expect(current).toEqual(deals);
      expect(older).toEqual([]);
    }
  });

  it('clears paid and lost deals past the cut-off, keeping recent ones', () => {
    const fresh = { id: 'fresh', stageChangedAt: daysAgo(CLEAR_AFTER_DAYS - 1) };
    const stale = { id: 'stale', stageChangedAt: daysAgo(CLEAR_AFTER_DAYS + 1) };
    for (const stage of ['paid', 'lost']) {
      const { current, older } = splitOlderDeals(stage, [fresh, stale]);
      expect(current).toEqual([fresh]);
      expect(older).toEqual([stale]);
    }
  });

  it('ages on time in stage, not on when the deal was created', () => {
    // Won last week off a lead we opened two years ago — that's live business.
    const deal = { id: 'x', createdAt: daysAgo(700), stageChangedAt: daysAgo(5) };
    expect(splitOlderDeals('paid', [deal]).current).toEqual([deal]);
  });

  it('falls back to createdAt when a legacy deal has no stage change recorded', () => {
    const legacy = { id: 'legacy', createdAt: daysAgo(500), stageChangedAt: null };
    expect(splitOlderDeals('lost', [legacy]).older).toEqual([legacy]);
  });

  it('keeps a deal with no dates at all on the board rather than hiding it', () => {
    const undated = { id: 'undated' };
    expect(splitOlderDeals('paid', [undated]).current).toEqual([undated]);
  });
});
