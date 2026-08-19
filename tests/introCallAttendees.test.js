// Who ends up on a portal-booked call.
//
// Written after a kick-off was booked for a deal and the person who sold it
// was never invited: the calendar invite was built from producer + assignees,
// which is also the set every offered slot has to be free for, so the deal's
// owner appeared in neither.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});
// The slot engine reaches Google on import paths we don't exercise here.
vi.mock('../api/_lib/gmailTokens.js', () => ({ getFreshAccessToken: async () => 'tok' }));
vi.mock('../api/_lib/googleCalendar.js', () => ({
  freeBusy: async () => [],
  createEventWithMeet: async () => ({ eventId: 'e', meetUrl: null }),
  getEventAttendees: async () => null,
  deleteEvent: async () => {},
}));

const { setSqlHandler, resetSqlMock } = await import('./helpers/mockDb.js');
const { getDealAttendees } = await import('../api/_lib/crm/introCallSlots.js');

// Rows come back in query order: the deal, then its assignees.
function withDeal({ producer, owner, assignees = [] }) {
  setSqlHandler((text) => {
    if (/FROM deals/.test(text)) return [{ producer_email: producer, owner_email: owner }];
    if (/deal_assignees/.test(text)) return assignees.map((e) => ({ user_email: e }));
    return [];
  });
}

beforeEach(() => resetSqlMock());

describe('getDealAttendees', () => {
  it('invites the deal owner, who used to be left off entirely', async () => {
    withDeal({ producer: 'hannah@squideo.co.uk', owner: 'callum@squideo.co.uk' });
    const { attendees, optional } = await getDealAttendees('d1');
    expect(attendees).toEqual(['hannah@squideo.co.uk']);
    expect(optional).toEqual(['callum@squideo.co.uk']);
  });

  // The reason the owner is optional rather than required: `attendees` is the
  // set every offered slot must be free for. A salesperson's diary deciding
  // what a client can book would gut availability to seat someone whose
  // attendance is welcome, not necessary.
  it('keeps the owner out of the availability set', async () => {
    withDeal({ producer: 'hannah@squideo.co.uk', owner: 'callum@squideo.co.uk' });
    const { attendees } = await getDealAttendees('d1');
    expect(attendees).not.toContain('callum@squideo.co.uk');
  });

  it('does not list someone twice when they own and produce the deal', async () => {
    withDeal({ producer: 'hannah@squideo.co.uk', owner: 'hannah@squideo.co.uk' });
    const { attendees, optional } = await getDealAttendees('d1');
    expect(attendees).toEqual(['hannah@squideo.co.uk']);
    expect(optional).toEqual([]);
  });

  it('does not demote an owner who is also an assignee', async () => {
    withDeal({
      producer: 'hannah@squideo.co.uk',
      owner: 'callum@squideo.co.uk',
      assignees: ['callum@squideo.co.uk'],
    });
    const { attendees, optional } = await getDealAttendees('d1');
    expect(attendees).toEqual(['hannah@squideo.co.uk', 'callum@squideo.co.uk']);
    expect(optional).toEqual([]);
  });

  it('hosts on the producer, not the owner', async () => {
    withDeal({ producer: 'hannah@squideo.co.uk', owner: 'callum@squideo.co.uk' });
    expect((await getDealAttendees('d1')).organizer).toBe('hannah@squideo.co.uk');
  });

  it('lower-cases addresses so a mixed-case owner is still deduped', async () => {
    withDeal({ producer: 'Hannah@Squideo.co.uk', owner: 'HANNAH@squideo.co.uk' });
    const { attendees, optional } = await getDealAttendees('d1');
    expect(attendees).toEqual(['hannah@squideo.co.uk']);
    expect(optional).toEqual([]);
  });

  it('copes with a deal that has no owner or no producer', async () => {
    withDeal({ producer: null, owner: 'callum@squideo.co.uk', assignees: ['jo@squideo.co.uk'] });
    const a = await getDealAttendees('d1');
    expect(a.organizer).toBe('jo@squideo.co.uk');
    expect(a.optional).toEqual(['callum@squideo.co.uk']);

    withDeal({ producer: 'hannah@squideo.co.uk', owner: null });
    const b = await getDealAttendees('d1');
    expect(b.optional).toEqual([]);
  });

  it('returns an empty shape for a deal that does not exist', async () => {
    setSqlHandler(() => []);
    expect(await getDealAttendees('nope')).toEqual({ organizer: null, attendees: [], optional: [] });
  });
});
