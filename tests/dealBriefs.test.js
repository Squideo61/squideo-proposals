// Which video a client brief belongs to, and how finished it is.
//
// The resolution matters more than it looks: the deal page and the video page
// both call this, so a brief that reads "Video 1" on the deal but resolves
// elsewhere on the video page would simply never appear where it says it is.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/_lib/db.js', async () => {
  const mod = await import('./helpers/mockDb.js');
  return { default: mod.sqlMock };
});

import { setSqlHandler, resetSqlMock } from './helpers/mockDb.js';
import { briefsForDeal, briefStatus } from '../api/_lib/brief/dealBriefs.js';
import { ALL_QUESTIONS } from '../api/_lib/brief/questions.js';

const FULL = Object.fromEntries(
  ALL_QUESTIONS.filter((q) => !q.screenOptional).map((q) => [q.key, 'answered']));

const VIDEOS = [
  { id: 'v1', title: 'Video 1', video_number: 1 },
  { id: 'v2', title: 'Video 2', video_number: 2 },
];

function brief(over = {}) {
  return {
    id: 'brf_1',
    title: 'CareConnect',
    answers: {},
    completed_at: null,
    submitted_at: null,
    updated_at: '2026-08-20T10:00:00Z',
    contributor_count: 1,
    reopened_at: null,
    video_id: null,
    submitted_by_name: null,
    submitted_by_email: null,
    ...over,
  };
}

function install({ briefs = [], videos = VIDEOS }) {
  setSqlHandler((text) => {
    if (text.includes('FROM client_briefs')) return briefs;
    if (text.includes('FROM project_videos')) return videos;
    return [];                                    // ensure*() DDL
  });
}

beforeEach(() => { resetSqlMock(); });

describe('which video a brief is for', () => {
  it('defaults to the first video, and says the default is a guess', async () => {
    install({ briefs: [brief()] });
    const { briefs: out } = await briefsForDeal('deal_1');
    expect(out[0].videoId).toBe('v1');
    expect(out[0].videoTitle).toBe('Video 1');
    // The flag is what lets the UI show "Video 1?" rather than claiming it.
    expect(out[0].videoAssumed).toBe(true);
  });

  it('uses an explicit choice, and stops calling it a guess', async () => {
    install({ briefs: [brief({ video_id: 'v2' })] });
    const { briefs: out } = await briefsForDeal('deal_1');
    expect(out[0].videoId).toBe('v2');
    expect(out[0].videoTitle).toBe('Video 2');
    expect(out[0].videoAssumed).toBe(false);
  });

  it('falls back to the default when the chosen video is gone', async () => {
    // Videos get archived to the recycle bin; the brief must not vanish with
    // one, nor claim to belong to a video that no longer exists.
    install({ briefs: [brief({ video_id: 'deleted' })] });
    const { briefs: out } = await briefsForDeal('deal_1');
    expect(out[0].videoId).toBe('v1');
    expect(out[0].videoAssumed).toBe(true);
  });

  it('copes with a deal that has no videos yet', async () => {
    install({ briefs: [brief()], videos: [] });
    const { briefs: out } = await briefsForDeal('deal_1');
    expect(out[0].videoId).toBe(null);
    expect(out[0].videoTitle).toBe(null);
  });

  it('names an untitled video by its number', async () => {
    install({ briefs: [brief()], videos: [{ id: 'v1', title: null, video_number: 3 }] });
    const { briefs: out } = await briefsForDeal('deal_1');
    expect(out[0].videoTitle).toBe('Video 3');
  });
});

describe('how finished a brief is', () => {
  const at = (pct) => ({ pct });

  it('is completed only once the client has SENT it', () => {
    expect(briefStatus({ submitted_at: '2026-08-20T10:00:00Z' }, at(100))).toBe('completed');
    // Every question answered but never sent is a different thing: we can read
    // it, but the client hasn't said they're finished with it.
    expect(briefStatus({ submitted_at: null }, at(100))).toBe('answered');
  });

  it('separates part-done from never-started', () => {
    expect(briefStatus({ submitted_at: null }, at(48))).toBe('part');
    expect(briefStatus({ submitted_at: null }, at(0))).toBe('empty');
  });

  it('reports a sent brief as completed even if questions were skipped', () => {
    // Optional questions mean a client can finalise below 100%. What they said
    // about being finished beats the fraction.
    expect(briefStatus({ submitted_at: '2026-08-20T10:00:00Z' }, at(88))).toBe('completed');
  });
});
