import { describe, it, expect, vi, beforeEach } from 'vitest';

// The reopen path is pure SQL + a mail send, so both are stubbed and the test
// asserts on the statements it issued and who it mailed.
vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});

const sent = [];
let sendShouldThrow = false;
vi.mock('../api/_lib/email.js', () => ({
  APP_URL: 'https://app.squideo.com',
  reviewReopenedHtml: ({ itemTitle, note }) => `<p>${itemTitle}${note ? ' — ' + note : ''}</p>`,
  sendMail: async (msg) => {
    // true = every send fails; a string = only that one address fails.
    if (sendShouldThrow === true || sendShouldThrow === msg.to) throw new Error('Resend is down');
    sent.push(msg);
  },
}));

// Portal feed + Gmail are side channels here; neither should be able to stop a
// reopen from happening.
const portalNotifications = [];
vi.mock('../api/_lib/portal/notifications.js', () => ({
  notifyPortalUser: async (n) => { portalNotifications.push(n); return 1; },
}));
vi.mock('../api/_lib/crm/gmail.js', () => ({ performGmailSend: async () => ({ ok: true }) }));

import { reopenReviewForClient } from '../api/_lib/crm/clientReview.js';
import { setSqlHandler, resetSqlMock, getSqlCalls } from './helpers/mockDb.js';

// A router-ish stand-in: answers the lookup with `row`, the viewer query with
// `viewers`, and every UPDATE/INSERT with nothing.
function installDb({ row, viewers = [] }) {
  setSqlHandler((text) => {
    if (/FROM revision_videos rv|FROM storyboards sb/.test(text)) return row ? [row] : [];
    if (/FROM revision_viewers|FROM storyboard_viewers/.test(text)) return viewers;
    return [];
  });
}

const VIDEO_ROW = {
  id: 'vid_1', title: 'Video 1', project_id: 'proj_1',
  approved_at: '2026-09-01T10:00:00Z', approved_by: 'Emma Vines',
  project_title: 'Guys Hospital London', share_token: 'tok_abc',
  company_id: 'co_1', deal_id: 'deal_1',
};

const STORYBOARD_ROW = { ...VIDEO_ROW, id: 'sb_1', title: 'Storyboard 1' };

beforeEach(() => {
  resetSqlMock();
  sent.length = 0;
  portalNotifications.length = 0;
  sendShouldThrow = false;
});

describe('reopenReviewForClient', () => {
  it('clears the video approval so the same draft unlocks', async () => {
    installDb({ row: VIDEO_ROW });
    const res = await reopenReviewForClient({
      kind: 'video', itemId: 'vid_1', actorEmail: 'adam@squideo.co.uk',
    });

    expect(res).toMatchObject({ ok: true, itemTitle: 'Video 1', wasApproved: true, notified: 0 });
    const update = getSqlCalls().find(c => /UPDATE revision_videos/.test(c.text));
    expect(update).toBeTruthy();
    // All three stamps have to go: approved_at is what locks comments, and
    // leaving feedback_submitted_at set would keep the CRM claiming the client
    // had already sent their feedback in.
    expect(update.text).toContain('approved_at = NULL');
    expect(update.text).toContain('approved_by = NULL');
    expect(update.text).toContain('feedback_submitted_at = NULL');
  });

  // Storyboard locking is gated on approved_version (isDraftLocked), not just
  // approved_at — clearing only the timestamp would leave the draft locked.
  it('clears approved_version too on a storyboard', async () => {
    installDb({ row: STORYBOARD_ROW });
    await reopenReviewForClient({ kind: 'storyboard', itemId: 'sb_1', actorEmail: 'adam@squideo.co.uk' });

    const update = getSqlCalls().find(c => /UPDATE storyboards/.test(c.text));
    expect(update.text).toContain('approved_version = NULL');
    expect(getSqlCalls().some(c => /UPDATE revision_videos/.test(c.text))).toBe(false);
  });

  it('logs it to the deal and tells the portal', async () => {
    installDb({ row: VIDEO_ROW });
    await reopenReviewForClient({
      kind: 'video', itemId: 'vid_1', actorEmail: 'adam@squideo.co.uk', note: '  Sorry — reopened for your team.  ',
    });

    const log = getSqlCalls().find(c => /INSERT INTO deal_events/.test(c.text));
    expect(log).toBeTruthy();
    const payload = JSON.parse(log.values.find(v => typeof v === 'string' && v.startsWith('{')));
    expect(payload).toMatchObject({
      video: 'Video 1', previouslyApprovedBy: 'Emma Vines',
      note: 'Sorry — reopened for your team.', emailed: false,
    });
    expect(portalNotifications[0]).toMatchObject({ key: 'portal.revision_reopened', dealId: 'deal_1' });
  });

  it('emails the share-link reviewers when asked, minus our own team', async () => {
    installDb({
      row: VIDEO_ROW,
      viewers: [
        { email: 'c.jacobson@nhs.net' },
        { email: 'jazgillott@gmail.com' },
        { email: 'hannah@squideo.co.uk' },
      ],
    });
    const res = await reopenReviewForClient({
      kind: 'video', itemId: 'vid_1', actorEmail: 'adam@squideo.co.uk',
      notifyViewers: true, note: 'Reopened so the rest of your team can comment.',
    });

    expect(res.notified).toBe(2);
    // One send each: a review committee is often several organisations, and a
    // shared To: header would hand each of them the others' addresses.
    expect(sent).toHaveLength(2);
    expect(sent.map(m => m.to)).toEqual(['c.jacobson@nhs.net', 'jazgillott@gmail.com']);
    expect(sent[0].subject).toContain('Video 1');
    // The link has to carry the item, or eight reviewers land on video 1 of five.
    expect(sent[0].text).toContain('revision=tok_abc');
    expect(sent[0].text).toContain('item=vid_1');
  });

  it('does not email anyone unless notifyViewers is set', async () => {
    installDb({ row: VIDEO_ROW, viewers: [{ email: 'c.jacobson@nhs.net' }] });
    const res = await reopenReviewForClient({ kind: 'video', itemId: 'vid_1', actorEmail: 'adam@squideo.co.uk' });
    expect(sent).toHaveLength(0);
    expect(res.notified).toBe(0);
  });

  // The reopen is the point of the action and has already been committed by the
  // time we mail — a bounced covering email must not surface as a failure.
  it('still reports success when the covering email fails', async () => {
    installDb({ row: VIDEO_ROW, viewers: [{ email: 'c.jacobson@nhs.net' }] });
    sendShouldThrow = true;
    const res = await reopenReviewForClient({
      kind: 'video', itemId: 'vid_1', actorEmail: 'adam@squideo.co.uk', notifyViewers: true,
    });
    expect(res).toMatchObject({ ok: true, notified: 0 });
  });

  // One bad address on a committee of eight shouldn't silence the other seven.
  it('carries on past an address that bounces', async () => {
    installDb({
      row: VIDEO_ROW,
      viewers: [{ email: 'bounces@nhs.net' }, { email: 'jazgillott@gmail.com' }],
    });
    sendShouldThrow = 'bounces@nhs.net';
    const res = await reopenReviewForClient({
      kind: 'video', itemId: 'vid_1', actorEmail: 'adam@squideo.co.uk', notifyViewers: true,
    });
    expect(res.notified).toBe(1);
    expect(sent.map(m => m.to)).toEqual(['jazgillott@gmail.com']);
  });

  it('reports a missing item rather than writing anything', async () => {
    installDb({ row: null });
    const res = await reopenReviewForClient({ kind: 'video', itemId: 'nope', actorEmail: 'adam@squideo.co.uk' });
    expect(res).toEqual({ error: 'not-found' });
    expect(getSqlCalls().some(c => /UPDATE revision_videos/.test(c.text))).toBe(false);
  });

  // Reopening something that was never finalised is harmless but shouldn't
  // claim otherwise — the caller uses this to word its confirmation.
  it('flags when there was no approval to clear', async () => {
    installDb({ row: { ...VIDEO_ROW, approved_at: null, approved_by: null } });
    const res = await reopenReviewForClient({ kind: 'video', itemId: 'vid_1', actorEmail: 'adam@squideo.co.uk' });
    expect(res.wasApproved).toBe(false);
  });
});
