import { describe, it, expect } from 'vitest';
import { serialisePortalNotification } from '../api/_lib/portal/notificationShape.js';

// The portal notification feed serialiser: DB row → allowlisted camelCase API
// shape (no SELECT * passthrough leaking portal_user_id / company_id etc.).

describe('serialisePortalNotification', () => {
  const row = {
    id: 'ntf_1',
    portal_user_id: 'pu_secret',
    company_id: 'co_1',
    deal_id: 'deal_1',
    notification_key: 'portal.task_reminder',
    title: 'Reminder: tasks waiting on you',
    body: '2 tasks left on Brand Video.',
    link: '#/project/deal_1',
    created_at: '2026-07-28T09:00:00Z',
    read_at: null,
  };

  it('maps to the camelCase client shape', () => {
    expect(serialisePortalNotification(row)).toEqual({
      id: 'ntf_1',
      key: 'portal.task_reminder',
      title: 'Reminder: tasks waiting on you',
      body: '2 tasks left on Brand Video.',
      link: '#/project/deal_1',
      createdAt: '2026-07-28T09:00:00Z',
      readAt: null,
    });
  });

  it('does not leak internal columns', () => {
    const out = serialisePortalNotification(row);
    expect(out).not.toHaveProperty('portal_user_id');
    expect(out).not.toHaveProperty('company_id');
    expect(out).not.toHaveProperty('deal_id');
  });

  it('passes a read timestamp through as readAt', () => {
    const out = serialisePortalNotification({ ...row, read_at: '2026-07-28T10:00:00Z' });
    expect(out.readAt).toBe('2026-07-28T10:00:00Z');
  });
});
