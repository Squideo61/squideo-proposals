// Which video/draft a client review link opens on. The bug this covers: a share
// token is project-wide, the viewer took videos[0], and videos come back in
// creation order — so an email about video 3 opened video 1, usually on a draft
// the client had already signed off.
import { describe, it, expect } from 'vitest';
import { pickReviewDefault, newestVersion } from '../src/lib/reviewDefaults.js';

const V = (id, n, iso) => ({ id, versionNumber: n, createdAt: iso });
const awaiting = (v) => !v.approvedAt && !v.feedbackSubmittedAt;

// A three-video deal: 1 approved, 2 has feedback in, 3 was sent last week.
const videos = [
  { id: 'v1', approvedAt: '2026-06-01', feedbackSubmittedAt: null, versions: [V('a2', 2, '2026-05-20'), V('a1', 1, '2026-05-01')] },
  { id: 'v2', approvedAt: null, feedbackSubmittedAt: '2026-06-10', versions: [V('b1', 1, '2026-06-05')] },
  { id: 'v3', approvedAt: null, feedbackSubmittedAt: null, versions: [V('c2', 2, '2026-08-01'), V('c1', 1, '2026-07-01')] },
];

describe('pickReviewDefault', () => {
  it('opens the newest draft still waiting on the client, not the first video', () => {
    expect(pickReviewDefault(videos, { isAwaiting: awaiting })).toEqual({ itemId: 'v3', versionId: 'c2' });
  });

  it('honours the video a link names', () => {
    expect(pickReviewDefault(videos, { itemId: 'v1', isAwaiting: awaiting })).toEqual({ itemId: 'v1', versionId: 'a2' });
  });

  it('lets a per-draft link win over the video it names', () => {
    expect(pickReviewDefault(videos, { itemId: 'v3', versionId: 'a1', isAwaiting: awaiting }))
      .toEqual({ itemId: 'v1', versionId: 'a1' });
  });

  it('falls back when the link points at something the viewer cannot see', () => {
    // Deleted video, deleted draft, or a draft not submitted yet.
    expect(pickReviewDefault(videos, { itemId: 'gone', isAwaiting: awaiting })).toEqual({ itemId: 'v3', versionId: 'c2' });
    expect(pickReviewDefault(videos, { versionId: 'gone', isAwaiting: awaiting })).toEqual({ itemId: 'v3', versionId: 'c2' });
    expect(pickReviewDefault([{ id: 'v0', versions: [] }, ...videos], { itemId: 'v0', isAwaiting: awaiting }))
      .toEqual({ itemId: 'v3', versionId: 'c2' });
  });

  it('still picks the most recent draft when nothing is outstanding', () => {
    const done = videos.map((v) => ({ ...v, approvedAt: '2026-06-01', feedbackSubmittedAt: null }));
    expect(pickReviewDefault(done, { isAwaiting: awaiting })).toEqual({ itemId: 'v3', versionId: 'c2' });
  });

  it('does not show "nothing uploaded yet" because the first video was never sent', () => {
    expect(pickReviewDefault([{ id: 'v0', versions: [] }, videos[2]], { isAwaiting: awaiting }))
      .toEqual({ itemId: 'v3', versionId: 'c2' });
  });

  it('reports the empty state only when there really is nothing to see', () => {
    expect(pickReviewDefault([{ id: 'v0', versions: [] }], { isAwaiting: awaiting })).toEqual({ itemId: 'v0', versionId: null });
    expect(pickReviewDefault([], {})).toEqual({ itemId: null, versionId: null });
    expect(pickReviewDefault(null, {})).toEqual({ itemId: null, versionId: null });
  });
});

describe('newestVersion', () => {
  it('takes the highest draft number', () => {
    expect(newestVersion(videos[0]).id).toBe('a2');
  });

  it('breaks a reused draft number by upload date', () => {
    // deleteVersion hard-deletes, so a re-upload can repeat version_number.
    expect(newestVersion({ versions: [V('old', 3, '2026-01-01'), V('new', 3, '2026-02-01')] }).id).toBe('new');
  });

  it('handles an item with no drafts', () => {
    expect(newestVersion({ versions: [] })).toBeNull();
    expect(newestVersion(null)).toBeNull();
  });
});
