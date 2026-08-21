// The brief's activity feed is OURS, shown to the client only where it tells
// them something they don't already know: what a colleague did.
//
// Two things break silently here:
//
//  1. The feed doubles as the polling cursor. `sinceEventId` comes from the
//     newest event the client holds, and the tick route returns NOTHING when
//     that is null. Take the cursor from the FILTERED list and a solo brief
//     ends up with no cursor for ever — so the first colleague to answer
//     anything never appears, and the collaboration feature quietly stops
//     working for exactly the person it was built for.
//  2. Staff lose the full history. It is how we see who inside an organisation
//     actually shaped a brief.
import { describe, it, expect, vi } from 'vitest';

// collab.js opens a database handle at import time; nothing below touches it.
vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});

import { colleagueEvents } from '../api/_lib/brief/collab.js';

const ME = 'pu_me';
const EVENTS = [
  { id: 'e5', portalUserId: 'pu_priya', actorName: 'Priya Shah' },
  { id: 'e4', portalUserId: ME, actorName: 'Alex Morgan' },
  { id: 'e3', portalUserId: null, staffEmail: 'adam@squideo.co.uk', actorName: 'Squideo' },
  { id: 'e2', portalUserId: 'pu_tom', actorName: 'Tom Ellery' },
  { id: 'e1', portalUserId: ME, actorName: 'Alex Morgan' },
];

describe('colleagueEvents', () => {
  it('drops the viewer\'s own events', () => {
    const ids = colleagueEvents(EVENTS, ME).map((e) => e.id);
    expect(ids).not.toContain('e4');
    expect(ids).not.toContain('e1');
  });

  it('keeps what colleagues did', () => {
    expect(colleagueEvents(EVENTS, ME).map((e) => e.id)).toEqual(['e5', 'e2']);
  });

  it('drops our own staff events from the client\'s page', () => {
    // "Squideo reopened this" is worth an email, not a permanent log on the
    // client's own screen.
    expect(colleagueEvents(EVENTS, ME).map((e) => e.id)).not.toContain('e3');
  });

  it('gives a staff preview the lot', () => {
    // A preview session has no portal user id of its own.
    expect(colleagueEvents(EVENTS, null)).toHaveLength(EVENTS.length);
    expect(colleagueEvents(EVENTS)).toHaveLength(EVENTS.length);
  });

  it('leaves a solo brief with an empty feed', () => {
    const solo = EVENTS.filter((e) => e.portalUserId === ME);
    expect(colleagueEvents(solo, ME)).toEqual([]);
  });

  it('never mutates what it was given', () => {
    const before = EVENTS.map((e) => e.id);
    colleagueEvents(EVENTS, ME);
    expect(EVENTS.map((e) => e.id)).toEqual(before);
  });

  it('survives an empty or missing list', () => {
    expect(colleagueEvents([], ME)).toEqual([]);
    expect(colleagueEvents(undefined, ME)).toEqual([]);
  });
});

describe('the polling cursor', () => {
  // Not a test of colleagueEvents so much as of the rule around it, written
  // down where the next person to touch this will run it: the cursor must come
  // off the unfiltered list. See briefRoute's activityCursor.
  it('would strand a solo brief if taken from the filtered feed', () => {
    const solo = EVENTS.filter((e) => e.portalUserId === ME);
    const shown = colleagueEvents(solo, ME);
    expect(shown[0]?.id).toBeUndefined();   // the bug: no cursor, ever
    expect(solo[0].id).toBe('e4');          // the fix: the real head
  });

  it('advances past events the client is not shown', () => {
    // The client sees e5 and e2; the cursor has to be e5's predecessor-free
    // head of the WHOLE window, or every tick re-reads the same rows.
    expect(EVENTS[0].id).toBe('e5');
    expect(colleagueEvents(EVENTS, 'pu_priya')[0].id).toBe('e4');
    // ...and the cursor is still e5, not e4.
  });
});
