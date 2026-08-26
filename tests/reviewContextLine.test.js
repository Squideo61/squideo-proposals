import { describe, it, expect, vi } from 'vitest';

// email.js opens a database handle at import time. The helper under test is
// pure — nothing below touches the database or sends anything.
vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock, batchWrite: async () => {} };
});

import { reviewContextLine } from '../api/_lib/email.js';

// The "which client, which project?" line on every video/storyboard review
// notification. Without it the bell reads "Luke finalised Video 2", where Luke
// is whoever clicked finalise and "Video 2" is a title half the projects share.

describe('reviewContextLine', () => {
  it('names both when they differ', () => {
    expect(reviewContextLine({ clientName: 'CareConnect', projectTitle: 'Brand Launch' }))
      .toBe('CareConnect · Brand Launch');
  });

  it('collapses a project named after its client, rather than stuttering', () => {
    expect(reviewContextLine({
      clientName: 'Global Baggage Solutions',
      projectTitle: 'Global Baggage Solutions',
    })).toBe('Global Baggage Solutions');
  });

  it('treats a casing or whitespace difference as the same name', () => {
    expect(reviewContextLine({ clientName: 'Kingspan Ltd', projectTitle: '  kingspan ltd  ' }))
      .toBe('Kingspan Ltd');
  });

  it('falls back to whichever one it has', () => {
    expect(reviewContextLine({ clientName: null, projectTitle: 'Sandip Rivival' })).toBe('Sandip Rivival');
    expect(reviewContextLine({ clientName: 'NHS RAF Trial', projectTitle: null })).toBe('NHS RAF Trial');
  });

  // The callers join this into a longer body with ' · ', so an empty string has
  // to stay empty — a stray separator would read as a missing field.
  it('returns an empty string when it knows nothing', () => {
    expect(reviewContextLine({})).toBe('');
    expect(reviewContextLine({ clientName: '   ', projectTitle: '' })).toBe('');
  });

  it('ignores values that are not strings', () => {
    expect(reviewContextLine({ clientName: 42, projectTitle: 'Xantaro' })).toBe('Xantaro');
  });
});
