// The sample project a prospect drives at /portal#/demo.
//
// Two things must stay true or the tour quietly stops being a demo. First, the
// fixtures have to keep the SHAPE of the real public payloads — VideoRevision
// and StoryboardRevision are handed the fixture unchanged, so a renamed field
// shows up as an empty player rather than an error. Second, nothing here may
// reach the network or the database: the whole reason the sample project is a
// fixture is that a shared demo row would be a graffiti wall every prospect
// could see.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// activity.js talks to the database at import time; the labelling it exports
// doesn't, and that's what's under test here.
vi.mock('../api/_lib/db.js', () => ({ default: vi.fn(async () => []), batchWrite: vi.fn() }));

// A minimal sessionStorage — the demo store is the only browser API in play.
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
globalThis.sessionStorage = new MemoryStorage();

const { buildDemoData, buildDemoStoryboardData } = await import('../src/portal/demo/fixtures.js');
const { createDemoRevApi } = await import('../src/portal/demo/demoRevApi.js');
const { createDemoSbApi } = await import('../src/portal/demo/demoSbApi.js');
const { resetDemo, demoProgress } = await import('../src/portal/demo/store.js');
const { describeActivity } = await import('../api/_lib/portal/activity.js');
const { DEMO_STAGES, demoConfigured } = await import('../src/portal/demo/stages.js');

const CONFIG = {
  title: 'Sample project',
  videoUrl: 'https://blob.example/sample.mp4',
  storyboardPdfUrl: 'https://blob.example/sample.pdf',
};
const IDENTITY = { name: 'Priya Prospect', email: 'Priya@Example.com' };

beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
  resetDemo();
});

describe('fixture shapes match the real public payloads', () => {
  it('the video fixture carries every field VideoRevision reads', () => {
    const d = buildDemoData(CONFIG);
    expect(Object.keys(d).sort()).toEqual(['activeViewers', 'callUrl', 'clientName', 'comments', 'title', 'videos']);
    const v = d.videos[0];
    expect(v).toMatchObject({ id: expect.any(String), approvedAt: null, feedbackSubmittedAt: null });
    // Two versions on purpose — one hides the version switcher, and the
    // switcher is half of what makes a review feel like a review.
    expect(v.versions).toHaveLength(2);
    expect(v.versions[0]).toMatchObject({ videoUrl: CONFIG.videoUrl, versionNumber: 2 });
  });

  it('the storyboard fixture carries every field StoryboardRevision reads', () => {
    const d = buildDemoStoryboardData(CONFIG);
    expect(Object.keys(d).sort()).toEqual(['activeViewers', 'callUrl', 'clientName', 'comments', 'storyboards', 'title']);
    const sb = d.storyboards[0];
    expect(sb).toMatchObject({ approvedAt: null, feedbackSubmittedAt: null });
    expect(sb.versions).toHaveLength(2);
    expect(sb.versions[0]).toMatchObject({ pdfUrl: CONFIG.storyboardPdfUrl, versionNumber: 2 });
    // Seeded comments must sit on drafts that exist, or the thread is empty
    // on the slide the visitor lands on.
    const ids = new Set(sb.versions.map((v) => v.id));
    d.comments.forEach((c) => expect(ids.has(c.versionId)).toBe(true));
  });

  it('leaves the slide count to the PDF so a swapped file cannot lie', () => {
    buildDemoStoryboardData(CONFIG).storyboards[0].versions
      .forEach((v) => expect(v.pageCount).toBeNull());
  });

  it('falls back to the current PDF when no earlier draft is uploaded', () => {
    const both = buildDemoStoryboardData(CONFIG).storyboards[0].versions;
    expect(both[1].pdfUrl).toBe(CONFIG.storyboardPdfUrl);
    const withV1 = buildDemoStoryboardData({ ...CONFIG, storyboardPdfUrlV1: 'https://blob.example/v1.pdf' });
    expect(withV1.storyboards[0].versions[1].pdfUrl).toBe('https://blob.example/v1.pdf');
  });

  it('renders the review furniture even when nothing is configured', () => {
    expect(() => buildDemoData({})).not.toThrow();
    expect(() => buildDemoStoryboardData({})).not.toThrow();
    expect(buildDemoStoryboardData({}).storyboards[0].versions[0].pdfUrl).toBeNull();
  });
});

// The dashboard renders the sample AS a project card, driven by this list. If
// it ever imported the list from DemoProject.jsx it would drag pdf.js into the
// bundle every client loads on sign-in — hence the separate module.
describe('which stages the tour offers', () => {
  it('offers each stage only once its file is uploaded', () => {
    const sb = DEMO_STAGES.find((s) => s.key === 'storyboard');
    const vid = DEMO_STAGES.find((s) => s.key === 'video');
    expect(sb.ready({ storyboardPdfUrl: 'x' })).toBe(true);
    expect(sb.ready({ videoUrl: 'x' })).toBe(false);
    expect(vid.ready({ videoUrl: 'x' })).toBe(true);
    expect(vid.ready({ storyboardPdfUrl: 'x' })).toBe(false);
  });

  it('survives a missing or empty config rather than throwing', () => {
    DEMO_STAGES.forEach((s) => {
      expect(s.ready(undefined)).toBe(false);
      expect(s.ready({})).toBe(false);
    });
    expect(demoConfigured(undefined)).toBe(false);
    expect(demoConfigured({})).toBe(false);
  });

  it('counts as configured when either half is uploaded', () => {
    expect(demoConfigured({ videoUrl: 'x' })).toBe(true);
    expect(demoConfigured({ storyboardPdfUrl: 'x' })).toBe(true);
  });

  it('gives every stage the copy the task list needs', () => {
    DEMO_STAGES.forEach((s) => {
      ['taskTitle', 'taskDetail', 'taskCta', 'doneDetail', 'label'].forEach((f) => {
        expect(typeof s[f]).toBe('string');
        expect(s[f].length).toBeGreaterThan(0);
      });
    });
  });

  it('runs storyboard before video, the way production does', () => {
    expect(DEMO_STAGES.map((s) => s.key)).toEqual(['storyboard', 'video']);
  });
});

describe('the sample storyboard behaves like the real one', () => {
  const build = () => createDemoSbApi({ config: CONFIG, identity: IDENTITY, onChange: null });

  it('keeps a posted comment, on the slide it was pinned to', async () => {
    const { api, load } = build();
    const created = await api.postStoryboardComment('t', {
      versionId: 'demo-sb-v2', body: 'Move the logo up', pageNumber: 2, anchorX: 0.4, anchorY: 0.6,
    });
    expect(created.mine).toBe(true);
    const after = load().comments.find((c) => c.id === created.id);
    expect(after).toMatchObject({ pageNumber: 2, anchorX: 0.4, body: 'Move the logo up' });
  });

  it('marks their own comments `mine` so edit and delete appear', async () => {
    const { api, load } = build();
    await api.postStoryboardComment('t', { body: 'Mine', pageNumber: 1 });
    const mine = load().comments.filter((c) => c.mine);
    expect(mine).toHaveLength(1);
    // Seeded comments belong to the cast, not the visitor.
    expect(load().comments.filter((c) => !c.mine).length).toBeGreaterThan(0);
  });

  it('edits and deletes round-trip through load()', async () => {
    const { api, load } = build();
    const c = await api.postStoryboardComment('t', { body: 'first go', pageNumber: 1 });
    await api.editStoryboardComment('t', c.id, 'second go');
    expect(load().comments.find((x) => x.id === c.id).body).toBe('second go');
    await api.deleteStoryboardComment('t', c.id);
    expect(load().comments.find((x) => x.id === c.id)).toBeUndefined();
  });

  it('can delete a seeded comment too, without it coming back', async () => {
    const { api, load } = build();
    const seeded = load().comments[0].id;
    await api.deleteStoryboardComment('t', seeded);
    expect(load().comments.some((c) => c.id === seeded)).toBe(false);
  });

  it('finalising stamps approval and the feedback submission together', async () => {
    const { api, load } = build();
    const res = await api.approveStoryboard('t', 'demo-sb-1', 'Priya Prospect');
    expect(res.approvedAt).toEqual(res.feedbackSubmittedAt);
    const sb = load().storyboards[0];
    expect(sb.approvedAt).toBe(res.approvedAt);
    expect(sb.approvedBy).toBe('Priya Prospect');
  });

  it('never invents a colleague who is also viewing', async () => {
    expect((await build().api.pollPublicStoryboard('t')).activeViewers).toEqual([]);
  });
});

describe('nothing reaches the network', () => {
  it('no demo write calls fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const sb = createDemoSbApi({ config: CONFIG, identity: IDENTITY, onChange: null });
    const rev = createDemoRevApi({ config: CONFIG, identity: IDENTITY, onChange: null });
    await sb.api.postStoryboardComment('t', { body: 'hi', pageNumber: 1 });
    await sb.api.approveStoryboard('t', 'demo-sb-1', 'Priya');
    await sb.api.recordStoryboardViewer('t', IDENTITY);
    await sb.api.recordStoryboardView('t', {});
    await rev.api.postRevisionComment('t', { body: 'hi' });
    await rev.api.approveRevision('t', 'demo-video-1', 'Priya');
    await rev.api.recordRevisionViewer('t', IDENTITY);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('start over', () => {
  it('clears BOTH stages, not just the one they were looking at', async () => {
    const sb = createDemoSbApi({ config: CONFIG, identity: IDENTITY, onChange: null });
    const rev = createDemoRevApi({ config: CONFIG, identity: IDENTITY, onChange: null });
    await sb.api.postStoryboardComment('t', { body: 'sb note', pageNumber: 1 });
    await rev.api.postRevisionComment('t', { body: 'video note' });
    expect(demoProgress()).toMatchObject({ video: { tried: true }, storyboard: { tried: true } });

    resetDemo();
    expect(demoProgress()).toMatchObject({ video: { tried: false }, storyboard: { tried: false } });
    expect(sb.load().comments.every((c) => !c.mine)).toBe(true);
    expect(rev.load().comments.every((c) => !c.mine)).toBe(true);
  });
});

// The activity feed is the whole point of reporting demo events — a row that
// reads "Finished a stage of the sample project" tells whoever's reading it
// nothing worth ringing someone about.
describe('how demo events read in the staff activity feed', () => {
  it('names which half of the tour they finished', () => {
    expect(describeActivity('demo.finalised', { stage: 'storyboard' })).toBe('Finished the sample storyboard');
    expect(describeActivity('demo.finalised', { stage: 'video' })).toBe('Finished the sample video review');
  });

  it('names the stage for a comment too', () => {
    expect(describeActivity('demo.commented', { stage: 'storyboard' })).toBe('Commented on the sample storyboard');
    expect(describeActivity('demo.commented', { stage: 'video' })).toBe('Commented on the sample video review');
  });

  it('falls back to something readable if the stage is missing or unknown', () => {
    expect(describeActivity('demo.finalised', {})).toBe('Finished a stage of the sample project');
    expect(describeActivity('demo.finalised', { stage: 'nonsense' })).toBe('Finished a stage of the sample project');
    expect(describeActivity('demo.commented', null)).toBe('Left a comment in the sample project');
  });

  it('labels the page view as trying it, not just opening it', () => {
    expect(describeActivity('view', { view: 'demo' })).toBe('Tried the sample project');
  });
});

describe('progress ticks on the overview', () => {
  it('counts a stage as tried once they comment', async () => {
    const sb = createDemoSbApi({ config: CONFIG, identity: IDENTITY, onChange: null });
    expect(demoProgress().storyboard).toMatchObject({ comments: 0, finalised: false, tried: false });
    await sb.api.postStoryboardComment('t', { body: 'note', pageNumber: 1 });
    expect(demoProgress().storyboard).toMatchObject({ comments: 1, tried: true });
  });

  it('counts a stage as tried when they finalise without commenting', async () => {
    const sb = createDemoSbApi({ config: CONFIG, identity: IDENTITY, onChange: null });
    await sb.api.approveStoryboard('t', 'demo-sb-1', 'Priya');
    expect(demoProgress().storyboard).toMatchObject({ comments: 0, finalised: true, tried: true });
  });

  it('does not count merely opening a stage', () => {
    createDemoSbApi({ config: CONFIG, identity: IDENTITY, onChange: null }).load();
    createDemoRevApi({ config: CONFIG, identity: IDENTITY, onChange: null }).load();
    expect(demoProgress()).toMatchObject({ video: { tried: false }, storyboard: { tried: false } });
  });
});
