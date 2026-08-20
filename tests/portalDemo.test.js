// The admin portal demo. Two properties matter more than any fixture in it:
//
//  1. It is decided by the URL and nothing else. It was briefly held in
//     sessionStorage, which an iframe shares with its parent tab and
//     window.open copies into the new one — so the admin panel embedding the
//     demo could have left the flag set in a tab that then opened a REAL
//     client's portal. A real portal quietly answering from fixtures is the
//     worst bug this feature could have.
//  2. It never reaches the network. The whole point is not seeding a demo
//     client, so a demo that falls through to fetch has failed at its one job.
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  DEMO_STATES, DEFAULT_DEMO_STATE, DEMO_QUERY_KEY,
  readDemoStateFromUrl, setDemoState, getDemoState, isDemoMode, demoRequest,
} from '../src/portal/demo/portalDemo.js';

// jsdom isn't configured for this suite, so stand in for the one browser API
// the module reads.
function atUrl(search) {
  globalThis.window = { location: { search } };
}

beforeEach(() => { atUrl(''); setDemoState(null); });

describe('demo mode is decided by the URL', () => {
  it('is off with no query param', () => {
    atUrl('');
    setDemoState(readDemoStateFromUrl());
    expect(isDemoMode()).toBe(false);
    expect(getDemoState()).toBeNull();
  });

  it('is off for a real portal preview', () => {
    atUrl('?preview=some.jwt.token');
    setDemoState(readDemoStateFromUrl());
    expect(isDemoMode()).toBe(false);
  });

  it('turns on for a known state', () => {
    atUrl(`?${DEMO_QUERY_KEY}=production`);
    setDemoState(readDemoStateFromUrl());
    expect(getDemoState()).toBe('production');
  });

  it('falls back rather than half-enabling on a junk state', () => {
    atUrl(`?${DEMO_QUERY_KEY}=not-a-state`);
    setDemoState(readDemoStateFromUrl());
    expect(getDemoState()).toBe(DEFAULT_DEMO_STATE);
  });
});

describe('the fake server', () => {
  it('answers every state without touching the network', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    for (const state of DEMO_STATES) {
      setDemoState(state.id);
      const me = await demoRequest('GET', 'me');
      expect(me.user.companies).toHaveLength(1);
      // Never flagged as a preview: preview chrome claims you're looking at a
      // real client's portal, which is the opposite of what this is.
      expect(me.preview).toBeNull();
      const overview = await demoRequest('GET', 'overview');
      expect(Array.isArray(overview.projects)).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gives a prospect no project and a client one', async () => {
    setDemoState('prospect');
    expect((await demoRequest('GET', 'overview')).projects).toHaveLength(0);
    setDemoState('production');
    expect((await demoRequest('GET', 'overview')).projects).toHaveLength(1);
  });

  it('shows the brief as shared, with colleagues on it', async () => {
    setDemoState('signed');
    const one = await demoRequest('GET', 'brief?id=demo-brief');
    expect(one.brief.contributors).toBe(3);
    expect(one.activity.length).toBeGreaterThan(1);
    // Someone mid-sentence, so presence has something to show.
    expect(one.presence.some((p) => p.questionKey)).toBe(true);
    expect(one.brief.locked).toBe(false);
  });

  it('locks the brief once the work is under way', async () => {
    setDemoState('production');
    const one = await demoRequest('GET', 'brief?id=demo-brief');
    expect(one.brief.locked).toBe(true);
    expect(one.presence).toEqual([]);
  });

  it('gates the finished video on the balance, like the real thing', async () => {
    setDemoState('revisions');
    expect((await demoRequest('GET', 'project?dealId=demo-deal')).project.finalReleaseUnlocked).toBe(false);
    setDemoState('delivered');
    expect((await demoRequest('GET', 'project?dealId=demo-deal')).project.finalReleaseUnlocked).toBe(true);
  });

  it('accepts writes quietly instead of erroring', async () => {
    setDemoState('signed');
    expect(await demoRequest('POST', 'track', { view: 'home' })).toEqual({ ok: true });
    // An action with no fixture degrades to an empty object, which every page
    // renders as its empty state — better than a demo of a crash.
    expect(await demoRequest('GET', 'partner')).toEqual({});
  });
});
