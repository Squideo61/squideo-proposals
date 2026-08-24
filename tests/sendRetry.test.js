import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => ({
  default: (await import('./helpers/mockDb.js')).sqlMock,
  batchWrite: async () => {},
}));

import { isRetryableSendError } from '../api/_lib/email.js';

// Which failures mean "not now" and which mean "never". Getting this backwards
// either writes off most of a campaign the first time a daily quota is hit, or
// retries a malformed address until the queue stops moving.
describe('a failed batch: retry or write off', () => {
  it('retries a rate limit', () => {
    expect(isRetryableSendError({ statusCode: 429, message: 'Too many requests' })).toBe(true);
    expect(isRetryableSendError({ name: 'rate_limit_exceeded', message: '' })).toBe(true);
  });

  it('retries a daily quota, which is the one a small plan hits', () => {
    // Resend's free tier stops at 100 a day. Without this, a 4,000-person
    // campaign would mark ~3,900 people permanently failed on day one.
    expect(isRetryableSendError({ name: 'daily_quota_exceeded', message: 'You have reached your daily limit' }))
      .toBe(true);
    expect(isRetryableSendError({ message: 'Monthly quota exceeded' })).toBe(true);
  });

  it('retries the provider having a moment', () => {
    expect(isRetryableSendError({ statusCode: 500, message: 'Internal server error' })).toBe(true);
    expect(isRetryableSendError({ statusCode: 503, message: '' })).toBe(true);
    expect(isRetryableSendError({ message: 'socket timeout' })).toBe(true);
  });

  it('does NOT retry a rejected address', () => {
    expect(isRetryableSendError({ statusCode: 422, message: 'Invalid `to` field' })).toBe(false);
    expect(isRetryableSendError({ statusCode: 400, message: 'Missing subject' })).toBe(false);
  });

  it('does NOT retry a bad API key', () => {
    // Retrying this forever would hide the actual problem behind a queue that
    // never empties.
    expect(isRetryableSendError({ statusCode: 401, message: 'API key is invalid' })).toBe(false);
    expect(isRetryableSendError({ statusCode: 403, message: 'Domain is not verified' })).toBe(false);
  });

  it('treats an unrecognised failure as final', () => {
    expect(isRetryableSendError({ message: 'something odd' })).toBe(false);
    expect(isRetryableSendError(null)).toBe(false);
  });
});
