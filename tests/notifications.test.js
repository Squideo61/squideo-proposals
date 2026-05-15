import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
}));

vi.mock('../api/_lib/email.js', () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
  APP_URL: 'https://app.squideo.com',
  adminEmailsExcluding: vi.fn().mockResolvedValue([]),
}));

import {
  NOTIFICATIONS,
  isValidNotificationKey,
  getNotificationMeta,
} from '../api/_lib/notificationsCatalog.js';
import {
  resolveRecipients,
  isEnabledForUser,
  sendNotification,
} from '../api/_lib/notifications.js';
import { sendMail } from '../api/_lib/email.js';
import {
  setSqlHandler,
  resetSqlMock,
} from './helpers/mockDb.js';

beforeEach(() => {
  resetSqlMock();
  sendMail.mockClear();
});

describe('NOTIFICATIONS catalog', () => {
  it('has unique non-empty keys', () => {
    const keys = NOTIFICATIONS.map(n => n.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('each entry declares a valid audience', () => {
    for (const n of NOTIFICATIONS) {
      expect(['broadcast', 'owner', 'assignee']).toContain(n.audience);
      expect(n.label).toBeTruthy();
      expect(n.description).toBeTruthy();
      expect(n.group).toBeTruthy();
    }
  });
});

describe('isValidNotificationKey', () => {
  it('accepts known keys', () => {
    expect(isValidNotificationKey('proposal.signed')).toBe(true);
    expect(isValidNotificationKey('quote_request.new')).toBe(true);
  });
  it('rejects unknown keys', () => {
    expect(isValidNotificationKey('proposal.deleted')).toBe(false);
    expect(isValidNotificationKey('')).toBe(false);
  });
});

describe('getNotificationMeta', () => {
  it('returns the entry for a known key', () => {
    expect(getNotificationMeta('proposal.signed')?.audience).toBe('broadcast');
  });
  it('returns null for unknown', () => {
    expect(getNotificationMeta('nope')).toBeNull();
  });
});

describe('resolveRecipients — broadcast', () => {
  it('returns subscribed users from the users+roles+overrides join', async () => {
    setSqlHandler(() => [
      { email: 'alice@example.com', enabled: true },
      { email: 'bob@example.com', enabled: false },
      { email: 'CARL@example.com', enabled: true },
    ]);
    const out = await resolveRecipients('proposal.signed', {});
    expect(out).toEqual(['alice@example.com', 'carl@example.com']);
  });
  it('respects excludeEmails (case-insensitive)', async () => {
    setSqlHandler(() => [
      { email: 'alice@example.com', enabled: true },
      { email: 'bob@example.com', enabled: true },
    ]);
    const out = await resolveRecipients('proposal.signed', { excludeEmails: ['ALICE@example.com'] });
    expect(out).toEqual(['bob@example.com']);
  });
  it('returns empty for unknown notification key', async () => {
    const out = await resolveRecipients('not.a.real.key', {});
    expect(out).toEqual([]);
  });
});

describe('resolveRecipients — owner', () => {
  it('returns the owner email when their pref resolves true', async () => {
    setSqlHandler(() => [{ enabled: true }]);
    const out = await resolveRecipients('proposal.first_view', { ownerEmail: 'owner@example.com' });
    expect(out).toEqual(['owner@example.com']);
  });
  it('returns empty when the owner has the pref off', async () => {
    setSqlHandler(() => [{ enabled: false }]);
    const out = await resolveRecipients('proposal.first_view', { ownerEmail: 'owner@example.com' });
    expect(out).toEqual([]);
  });
  it('returns empty when ownerEmail is missing', async () => {
    const out = await resolveRecipients('proposal.first_view', {});
    expect(out).toEqual([]);
  });
});

describe('resolveRecipients — assignee', () => {
  it('keeps only assignees whose pref is enabled', async () => {
    // 3 lookups: one per assignee. Each returns [{ enabled }].
    const responses = [
      [{ enabled: true }],   // a@
      [{ enabled: false }],  // b@
      [{ enabled: true }],   // c@
    ];
    let i = 0;
    setSqlHandler(() => responses[i++]);
    const out = await resolveRecipients('task.reminder', { assigneeEmails: ['a@e', 'B@E', 'c@e'] });
    expect(out).toEqual(['a@e', 'c@e']);
  });
  it('deduplicates assignees', async () => {
    setSqlHandler(() => [{ enabled: true }]);
    const out = await resolveRecipients('task.reminder', { assigneeEmails: ['A@e', 'a@e', 'a@e'] });
    expect(out).toEqual(['a@e']);
  });
});

describe('isEnabledForUser', () => {
  it('reads the joined effective state', async () => {
    setSqlHandler(() => [{ enabled: true }]);
    expect(await isEnabledForUser('a@e', 'proposal.signed')).toBe(true);
  });
  it('returns false when the user has no row', async () => {
    setSqlHandler(() => []);
    expect(await isEnabledForUser('ghost@e', 'proposal.signed')).toBe(false);
  });
});

describe('sendNotification', () => {
  it('calls sendMail with the resolved recipients', async () => {
    setSqlHandler(() => [
      { email: 'a@e', enabled: true },
      { email: 'b@e', enabled: true },
    ]);
    const r = await sendNotification('proposal.signed', {
      subject: 'Hi',
      html: '<p>x</p>',
      text: 'x',
    });
    expect(r.sent).toBe(2);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      to: ['a@e', 'b@e'],
      subject: 'Hi',
    });
  });
  it('merges extraRecipients (deduped) when subscribers are empty', async () => {
    setSqlHandler(() => []);
    const r = await sendNotification('quote_request.new', {
      subject: 'New',
      html: '<p>x</p>',
      extraRecipients: ['adam@squideo.co.uk'],
    });
    expect(r.sent).toBe(1);
    expect(sendMail.mock.calls[0][0].to).toEqual(['adam@squideo.co.uk']);
  });
  it('skips sending when nobody subscribed and no extras', async () => {
    setSqlHandler(() => []);
    const r = await sendNotification('quote_request.new', {
      subject: 'New',
      html: '<p>x</p>',
    });
    expect(r.sent).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
