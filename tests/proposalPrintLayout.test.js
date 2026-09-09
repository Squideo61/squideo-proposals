// Layout of the printed proposal — the copy that goes to a client who can't
// use the link. Two things it kept getting wrong:
//
//   • the payment options printed as though we'd already chosen one (the
//     default 50/50 arrived ticked and highlighted), so there was nothing for
//     the client to mark;
//   • the delivery team sat in a fixed three-column grid, which for a team of
//     four marooned the fourth person on a row of their own beside half a page
//     of white.
//
// Both are print-only — the online proposal has its own interactive controls.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// printProposal resolves relative asset paths against window.location.origin
// and writes into a popup. Stub just enough of both to capture the HTML.
let written = '';
beforeEach(() => {
  written = '';
  const fakeDoc = {
    write: (html) => { written += html; },
    close: () => {},
    getElementById: () => null,
  };
  vi.stubGlobal('window', {
    location: { origin: 'https://app.squideo.com' },
    open: () => ({ document: fakeDoc, print: () => {} }),
  });
});

const { openPrintWindow, printOptionsForSigned } = await import('../src/utils/printProposal.js');

const member = (name, role) => ({ name, role, bio: `${name} does the ${role} work.`, photo: null });

const proposal = (over = {}) => ({
  clientName: 'Elaine Chan',
  contactBusinessName: 'Carr Kamasa Design',
  proposalTitle: 'Explainer video',
  date: '9 September 2026',
  validityDays: 28,
  basePrice: 2000,
  vatRate: 0.2,
  team: [member('Callum', 'Production Manager'), member('Chloe', 'Copywriter'), member('Hannah', 'Creative Director'), member('Ben', 'Founder')],
  baseInclusions: [],
  optionalExtras: [],
  paymentOptions: ['5050', 'full'],
  // Always present on a real proposal; the print builder reads its rates
  // unguarded, so the fixture carries it switched off.
  partnerProgramme: { enabled: false, discountRate: 0.10, extraDiscountPerCredit: 0.025, maxDiscount: 0.20 },
  ...over,
});

// The payment-options block, through to whatever signature block follows it.
// The heading differs between the blank copy and a signed one.
function paymentSection(html) {
  const start = Math.max(html.indexOf('Payment Options'), html.indexOf('Selected Payment Option'));
  const after = html.indexOf('Acceptance', start);
  const end = html.indexOf('Proposal Accepted', start);
  const stop = [after, end].filter((i) => i > start);
  return html.slice(start, stop.length ? Math.min(...stop) : html.length);
}

function teamSection(html) {
  const start = html.indexOf('Your Delivery Team');
  return html.slice(start, html.indexOf('Our Producers', start));
}

describe('payment options on the blank copy', () => {
  it('prints each option as a tickbox for the client to mark', () => {
    openPrintWindow(proposal(), { signable: true });
    const section = paymentSection(written);
    expect(section).toContain('50/50 split');
    expect(section).toContain('Pay in full');
    // One real checkbox per option, so a client with a pen has something to do.
    expect(section.match(/<input type="checkbox"/g) || []).toHaveLength(2);
  });

  it('does not pre-select one of them', () => {
    openPrintWindow(proposal(), { signable: true });
    const section = paymentSection(written);
    // The default paymentOption is '5050'; it used to arrive ticked and in the
    // blue "chosen" treatment, which reads as us having decided for them.
    expect(section).not.toContain('✓ ');
    expect(section).not.toContain('#F0F9FF');
  });
});

describe('payment option on a signed copy', () => {
  const signed = { name: 'Elaine Chan', signedAt: '2026-09-01T12:00:00.000Z', paymentOption: 'full', total: 2000, selectedExtras: [] };

  it('prints only the option taken, as a record rather than a form', () => {
    openPrintWindow(proposal(), printOptionsForSigned(signed, null));
    const section = paymentSection(written);
    expect(section).toContain('Pay in full');
    expect(section).not.toContain('50/50 split');
    // No tickbox — nothing left to choose — and it keeps the ticked highlight.
    expect(section).not.toContain('<input type="checkbox"');
    expect(section).toContain('✓ ');
  });
});

describe('where a signed copy is returned to', () => {
  it('names the person who raised the proposal, not the shared inbox', () => {
    // preparedByEmail is already the proposal's owner everywhere else — deal
    // owner, PO contact, who Stripe and view alerts ring — so a paper copy
    // should come back to them rather than landing in hello@ to be forwarded.
    openPrintWindow(proposal({ preparedByEmail: 'adam@squideo.co.uk' }), { signable: true });
    expect(written).toContain('Please return the signed copy to <strong>adam@squideo.co.uk</strong>');
  });

  it('falls back to the shared inbox when the proposal has no owner on it', () => {
    openPrintWindow(proposal({ preparedByEmail: null }), { signable: true });
    expect(written).toContain('<strong>hello@squideo.com</strong>');
  });
});

describe('the delivery team grid', () => {
  it('lays four people out 2x2 rather than stranding the fourth', () => {
    openPrintWindow(proposal(), { signable: true });
    expect(teamSection(written)).toContain('grid-template-columns:repeat(2,1fr)');
  });

  it('keeps three across one row', () => {
    openPrintWindow(proposal({ team: [member('Callum', 'PM'), member('Chloe', 'Copy'), member('Hannah', 'CD')] }), { signable: true });
    expect(teamSection(written)).toContain('grid-template-columns:repeat(3,1fr)');
  });

  it('keeps six as two rows of three', () => {
    const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => member(n, 'Producer'));
    openPrintWindow(proposal({ team: six }), { signable: true });
    expect(teamSection(written)).toContain('grid-template-columns:repeat(3,1fr)');
  });

  it('spans the last card across the row when one would otherwise be orphaned', () => {
    // Seven in threes leaves a single card on the last row; let it fill the
    // width instead of sitting beside a hole.
    const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => member(n, 'Producer'));
    openPrintWindow(proposal({ team: seven }), { signable: true });
    const section = teamSection(written);
    expect(section).toContain('grid-template-columns:repeat(3,1fr)');
    expect(section.match(/grid-column:1\/-1;/g) || []).toHaveLength(1);
    // …on the last card, not an earlier one: the style sits on the card's
    // opening div, so it must fall after the sixth person's name and before
    // the seventh's.
    const span = section.indexOf('grid-column:1/-1;');
    expect(span).toBeGreaterThan(section.indexOf('>F<'));
    expect(span).toBeLessThan(section.indexOf('>G<'));
  });

  it('does not span anything when the last row is already full', () => {
    openPrintWindow(proposal(), { signable: true });
    expect(teamSection(written)).not.toContain('grid-column:1/-1');
  });

  it('survives a proposal with no team on it', () => {
    expect(() => openPrintWindow(proposal({ team: undefined }), { signable: true })).not.toThrow();
  });
});
