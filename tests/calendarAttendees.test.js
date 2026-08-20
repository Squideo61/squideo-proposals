// Adding someone to a booked call.
//
// This is a read-modify-write against Google: events.patch REPLACES the whole
// attendee array, so the failure mode isn't "the new guest is missing", it's
// "everyone else got removed from the call, and the ones who survived had their
// RSVPs reset". Worth pinning down.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addEventAttendees } from '../api/_lib/googleCalendar.js';

let event;
let patched;

beforeEach(() => {
  patched = null;
  event = {
    organizer: { email: 'hannah@squideo.co.uk' },
    attendees: [
      { email: 'hannah@squideo.co.uk', responseStatus: 'accepted', organizer: true },
      { email: 'client@acl-uk.org', responseStatus: 'accepted' },
      { email: 'jo@squideo.co.uk', responseStatus: 'tentative', optional: true },
    ],
  };
  global.fetch = vi.fn(async (url, opts) => {
    if (!opts || opts.method !== 'PATCH') {
      return { ok: true, status: 200, json: async () => event };
    }
    patched = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ ...event, attendees: patched.body.attendees }) };
  });
});

describe('addEventAttendees', () => {
  it('appends without disturbing anyone already invited', async () => {
    await addEventAttendees('tok', 'ev1', ['callum@squideo.co.uk'], { optional: true });
    expect(patched.body.attendees).toHaveLength(4);
    // Every original entry survives byte-for-byte: RSVPs and optional flags
    // included. Rebuilding the list from addresses alone would have reset both.
    expect(patched.body.attendees.slice(0, 3)).toEqual(event.attendees);
    expect(patched.body.attendees[3]).toEqual({ email: 'callum@squideo.co.uk', optional: true });
  });

  // Without this Google adds them silently and never tells them the call exists
  // — which is the entire reason someone is doing this by hand.
  it('makes Google send the invite', async () => {
    await addEventAttendees('tok', 'ev1', ['callum@squideo.co.uk']);
    expect(patched.url).toContain('sendUpdates=all');
  });

  it('does nothing when they are already on it', async () => {
    const r = await addEventAttendees('tok', 'ev1', ['jo@squideo.co.uk']);
    expect(patched).toBeNull();
    expect(r.added).toEqual([]);
  });

  it('never re-adds the organizer as a guest', async () => {
    // Google rejects the duplicate, which would fail the whole request.
    const r = await addEventAttendees('tok', 'ev1', ['hannah@squideo.co.uk']);
    expect(patched).toBeNull();
    expect(r.added).toEqual([]);
  });

  it('matches case-insensitively, so a capitalised address is not a duplicate', async () => {
    const r = await addEventAttendees('tok', 'ev1', ['JO@Squideo.co.uk']);
    expect(patched).toBeNull();
    expect(r.added).toEqual([]);
  });

  it('adds the ones that are new and skips the ones that are not', async () => {
    const r = await addEventAttendees('tok', 'ev1', ['jo@squideo.co.uk', 'new@squideo.co.uk']);
    expect(r.added).toEqual(['new@squideo.co.uk']);
    expect(patched.body.attendees).toHaveLength(4);
  });

  it('copes with an event that has no attendees yet', async () => {
    event = { organizer: { email: 'hannah@squideo.co.uk' } };
    await addEventAttendees('tok', 'ev1', ['callum@squideo.co.uk']);
    expect(patched.body.attendees).toEqual([{ email: 'callum@squideo.co.uk', optional: false }]);
  });

  it('refuses a booking with no calendar event rather than patching nothing', async () => {
    await expect(addEventAttendees('tok', null, ['x@y.com'])).rejects.toThrow(/no calendar event/i);
  });

  it('does not call Google at all for an empty list', async () => {
    const r = await addEventAttendees('tok', 'ev1', []);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(r.added).toEqual([]);
  });
});
