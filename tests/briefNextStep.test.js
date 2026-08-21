// After a brief is sent, the client picks what happens next: a discovery call
// or just a quote. The call books through the ordinary intro-call engine, which
// normally takes its attendees from a deal's production team — but a discovery
// call happens BEFORE there is a deal, so it runs off an explicit host list in
// settings.intro_call_rules.
//
// That list is the fragile part. It arrives over a PUT that stores whatever
// shape it is handed, and it ends up as calendar attendees compared against
// connected Google accounts. A null, a number or a stray object in there takes
// out slot computation — not just for discovery calls, for every booking that
// merges the same rules.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});

import { mergeRules, DEFAULT_RULES } from '../api/_lib/crm/introCallSlots.js';

describe('discovery call hosts', () => {
  it('defaults to nobody, which is a working state', () => {
    // Empty means the portal offers "ask us to call you" rather than an empty
    // calendar — see computeSlotsForAttendees' no_team branch.
    expect(DEFAULT_RULES.discoveryHosts).toEqual([]);
    expect(mergeRules(null).discoveryHosts).toEqual([]);
    expect(mergeRules({}).discoveryHosts).toEqual([]);
  });

  it('keeps the emails it is given, normalised', () => {
    const r = mergeRules({ discoveryHosts: ['  Ben@Squideo.co.uk ', 'callum@squideo.co.uk'] });
    expect(r.discoveryHosts).toEqual(['ben@squideo.co.uk', 'callum@squideo.co.uk']);
  });

  it('de-duplicates, because a host listed twice is invited twice', () => {
    const r = mergeRules({ discoveryHosts: ['ben@squideo.co.uk', 'BEN@squideo.co.uk'] });
    expect(r.discoveryHosts).toEqual(['ben@squideo.co.uk']);
  });

  it('throws out anything that is not an email address', () => {
    const r = mergeRules({
      discoveryHosts: ['ben@squideo.co.uk', null, 42, { email: 'x@y.z' }, '', '   ', 'not-an-email'],
    });
    expect(r.discoveryHosts).toEqual(['ben@squideo.co.uk']);
  });

  it('survives a non-array entirely', () => {
    // The PUT stores what it is handed; this is the shape that would otherwise
    // reach .filter() and take every booking down with it.
    for (const bad of ['ben@squideo.co.uk', 42, {}, true]) {
      expect(mergeRules({ discoveryHosts: bad }).discoveryHosts).toEqual([]);
    }
  });

  it('leaves the rest of the rules alone', () => {
    const r = mergeRules({ discoveryHosts: ['ben@squideo.co.uk'], minNoticeHours: 4 });
    expect(r.minNoticeHours).toBe(4);
    expect(r.durationMinutes).toBe(DEFAULT_RULES.durationMinutes);
    expect(r.timezone).toBe(DEFAULT_RULES.timezone);
  });
});
