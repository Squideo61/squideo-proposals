// The prospect rail is a GROUPING, not a gate.
//
// Someone who typed a name and an email to get a brief template was being
// handed the full client portal: ten sections, six of them empty. The fix
// splits the rail under a "When your project starts" heading — and the whole
// value of doing it that way rather than hiding things is that nothing is
// actually taken away. Two ways that can silently rot:
//
//  1. A section ends up in neither group, and disappears from the rail for
//     prospects. Nobody notices, because the URL still works.
//  2. The grouping leaks into a CLIENT's rail, and a paying customer is told
//     their project hasn't started.
import { describe, it, expect } from 'vitest';
import { navGroups } from '../src/portal/nav.js';

const CLIENT = { id: 'co1', prospect: false };
const PROSPECT = { id: 'co2', prospect: true };
const keys = (groups) => groups.flatMap((g) => g.items.map((i) => i.view));

describe('navGroups', () => {
  it('gives a client one group, no heading', () => {
    const groups = navGroups(CLIENT, true);
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBeNull();
    expect(groups[0].muted).toBeFalsy();
  });

  it('splits a prospect in two, and names the second', () => {
    const groups = navGroups(PROSPECT, true);
    expect(groups).toHaveLength(2);
    expect(groups[0].heading).toBeNull();
    expect(groups[1].heading).toBe('When your project starts');
    expect(groups[1].muted).toBe(true);
  });

  it('shows a prospect every section a client sees', () => {
    // The point of the heading is that nothing is hidden behind it.
    expect(keys(navGroups(PROSPECT, true)).sort())
      .toEqual(keys(navGroups(CLIENT, true)).sort());
  });

  it('puts the brief first, for both', () => {
    // It is the lead magnet: the button on squideo.com that sent them here.
    expect(navGroups(PROSPECT, true)[0].items[0].view).toBe('brief');
    expect(navGroups(CLIENT, true)[0].items[0].view).toBe('brief');
  });

  it('keeps a prospect on what they can use today', () => {
    const [now, later] = navGroups(PROSPECT, true);
    const nowKeys = now.items.map((i) => i.view);
    // Their own work, and the shop window.
    expect(nowKeys).toEqual(expect.arrayContaining(['brief', 'demo', 'course', 'team', 'settings']));
    // Everything that needs a project in the account to mean anything.
    expect(later.items.map((i) => i.view))
      .toEqual(expect.arrayContaining(['home', 'library', 'documents', 'request']));
    expect(nowKeys).not.toContain('home');
  });

  it('still hides the rate card from a prospect entirely', () => {
    // Grouping must not have promoted video-credit into a visible-but-faded
    // row. It is not "later", it is not theirs — see CLIENT_ONLY in api/portal.js.
    const groups = navGroups({ ...PROSPECT, creditVisible: false }, true);
    expect(keys(groups)).not.toContain('video-credit');
  });

  it('drops the heading rather than leaving it bare', () => {
    // Nothing in the later group would otherwise render a label introducing an
    // empty list.
    const groups = navGroups(PROSPECT, false);
    for (const g of groups) expect(g.items.length).toBeGreaterThan(0);
  });

  it('treats an unknown prospect flag as a client', () => {
    // An older session payload without the flag must never tell a paying
    // client their project hasn't started.
    expect(navGroups({ id: 'co3' }, true)).toHaveLength(1);
    expect(navGroups(null, true)).toHaveLength(1);
  });

  it('hides the sample project until there is one, in either shape', () => {
    expect(keys(navGroups(PROSPECT, false))).not.toContain('demo');
    expect(keys(navGroups(CLIENT, false))).not.toContain('demo');
  });
});

// The demo is how anyone at Squideo actually looks at this. Its "prospect"
// state used to hand back a company flagged prospect:false, so the one state
// meant to show a brand-new visitor's portal was the one state showing it
// wrong — the full client rail, on the account with nothing in it.
describe('the demo prospect state', () => {
  it('hands back a company that is actually a prospect, and groups its rail', async () => {
    const { setDemoState, demoRequest } = await import('../src/portal/demo/portalDemo.js');
    setDemoState('prospect');
    const { company } = await demoRequest('GET', 'overview');
    expect(company.prospect).toBe(true);
    // And no rate card, the same as a real prospect — see CLIENT_ONLY.
    expect(company.creditVisible).toBe(false);
    expect(navGroups(company, true)).toHaveLength(2);
  });

  it('leaves the client states alone', async () => {
    const { setDemoState, demoRequest } = await import('../src/portal/demo/portalDemo.js');
    setDemoState('signed');
    const { company } = await demoRequest('GET', 'overview');
    expect(company.prospect).toBe(false);
    expect(navGroups(company, true)).toHaveLength(1);
  });
});
