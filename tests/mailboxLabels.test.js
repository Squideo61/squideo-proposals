import { describe, it, expect } from 'vitest';
import { actionToLabels } from '../api/_lib/crm/mailboxLabels.js';

describe('actionToLabels', () => {
  it('archive removes the INBOX label', () => {
    expect(actionToLabels('archive')).toEqual({ remove: ['INBOX'] });
  });

  it('markRead / markUnread toggle the UNREAD label', () => {
    expect(actionToLabels('markRead')).toEqual({ remove: ['UNREAD'] });
    expect(actionToLabels('markUnread')).toEqual({ add: ['UNREAD'] });
  });

  it('star / unstar toggle the STARRED label', () => {
    expect(actionToLabels('star')).toEqual({ add: ['STARRED'] });
    expect(actionToLabels('unstar')).toEqual({ remove: ['STARRED'] });
  });

  it('spam adds SPAM and removes INBOX; unspam reverses it', () => {
    expect(actionToLabels('spam')).toEqual({ add: ['SPAM'], remove: ['INBOX'] });
    expect(actionToLabels('unspam')).toEqual({ remove: ['SPAM'], add: ['INBOX'] });
  });

  it('trash / untrash route to the dedicated endpoints', () => {
    expect(actionToLabels('trash')).toEqual({ trash: true });
    expect(actionToLabels('untrash')).toEqual({ untrash: true });
  });

  it('returns null for an unknown action', () => {
    expect(actionToLabels('nope')).toBeNull();
    expect(actionToLabels(undefined)).toBeNull();
  });
});
