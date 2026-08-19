// computePortalOffers serves two audiences from one function: the client's
// "Add extras" page and the CRM's Client portal card. The client must never see
// an offer staff have hidden — that's the whole point of the eye toggle, and
// resolveOfferForAccept re-runs this to price an accept, so a leak here would be
// a sellable offer. Staff must see exactly the opposite, or hiding an extra is a
// one-way door with no row left to click to bring it back.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});
vi.mock('../api/_lib/portal/db.js', () => ({ ensurePortalTables: async () => {} }));

import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';
import { computePortalOffers } from '../api/_lib/portal/extrasOffers.js';

const DEAL = { id: 'd1', portal_extras_discount: 0.10 };

const PROPOSAL_EXTRAS = [
  { id: 'vo', label: 'Professional human voiceover artist', price: 125 },
  { id: 'thumb', label: 'Video thumbnail imagery', price: 40 },
];

// `offers` are the raw portal_extra_offers rows for the deal.
function install(offers) {
  setSqlHandler((text) => {
    if (text.includes('FROM proposals')) {
      return [{ id: 'p1', data: { optionalExtras: PROPOSAL_EXTRAS }, signature_data: { selectedExtras: [] } }];
    }
    if (text.includes('portal_extra_offers')) return offers;
    return [];
  });
}

beforeEach(() => resetSqlMock());

describe('computePortalOffers — hidden offers', () => {
  const hiddenThumb = {
    id: 'pxo1', kind: 'override', proposal_extra_id: 'thumb',
    title: null, description: null, amount: null, hidden: true,
  };
  const hiddenCustom = {
    id: 'pxo2', kind: 'custom', proposal_extra_id: null,
    title: 'Vertical cutdown', description: 'For socials', amount: 450, hidden: true,
  };

  it('drops a hidden proposal extra for the client', async () => {
    install([hiddenThumb]);
    const offers = await computePortalOffers(DEAL);
    expect(offers.map((o) => o.key)).toEqual(['prop:vo']);
    expect(offers[0].amount).toBe(112.5);
    expect(offers[0].hidden).toBe(false);
  });

  it('keeps it for staff, flagged, so the eye toggle can put it back', async () => {
    install([hiddenThumb]);
    const offers = await computePortalOffers(DEAL, { includeHidden: true });
    expect(offers.map((o) => o.key)).toEqual(['prop:vo', 'prop:thumb']);
    const thumb = offers.find((o) => o.key === 'prop:thumb');
    expect(thumb.hidden).toBe(true);
    // Still priced, so the staff row shows what the client would be offered.
    expect(thumb.amount).toBe(36);
    expect(thumb.originalAmount).toBe(40);
  });

  it('treats hidden custom upsells the same way', async () => {
    install([hiddenCustom]);
    expect((await computePortalOffers(DEAL)).map((o) => o.key)).toEqual(['prop:vo', 'prop:thumb']);

    const staff = await computePortalOffers(DEAL, { includeHidden: true });
    const custom = staff.find((o) => o.key === 'custom:pxo2');
    expect(custom.hidden).toBe(true);
    expect(custom.amount).toBe(450);
  });

  it('leaves a visible offer untouched under either flag', async () => {
    const visible = { ...hiddenCustom, hidden: false };
    install([visible]);
    const client = await computePortalOffers(DEAL);
    const staff = await computePortalOffers(DEAL, { includeHidden: true });
    expect(client).toEqual(staff);
    expect(client.every((o) => o.hidden === false)).toBe(true);
  });
});
