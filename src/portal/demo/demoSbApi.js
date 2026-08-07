// The sample storyboard's data layer — the storyboard twin of demoRevApi.js.
//
// Same method signatures as the real `sbApi` in Storyboard.jsx, backed by
// memory plus sessionStorage instead of the network, so StoryboardRevision
// can't tell the difference. A prospect pinning a note to slide 2 is driving
// the real sign-off surface, not a facsimile of it.

import { buildDemoStoryboardData, DEMO_SB_SEED_COMMENT_IDS } from './fixtures.js';
import { makeDemoStore, STORYBOARD_KEY } from './store.js';

const store = makeDemoStore(STORYBOARD_KEY);
const rid = () => 'demo-' + Math.random().toString(36).slice(2, 10);

// Returns { api, load } — `load` builds the current payload, `api` mutates it.
// `onChange` is called after every mutation so the page can re-render, mirroring
// how the real page re-polls after a write.
export function createDemoSbApi({ config, identity, onChange }) {
  const me = () => ({
    name: identity?.name || 'You',
    email: (identity?.email || 'you@example.com').toLowerCase(),
  });

  const load = () => {
    const base = buildDemoStoryboardData(config);
    const s = store.read();
    const added = Array.isArray(s.comments) ? s.comments : [];
    const removed = new Set(Array.isArray(s.removed) ? s.removed : []);
    const edits = s.edits || {};

    const comments = [...base.comments, ...added]
      .filter((c) => !removed.has(c.id))
      .map((c) => (edits[c.id] ? { ...c, body: edits[c.id] } : c))
      // Their own comments are marked `mine` so the real edit/delete affordances
      // appear — without it the demo silently hides half the interface.
      .map((c) => ({ ...c, mine: !!c.authorEmail && c.authorEmail === me().email }));

    const sb = base.storyboards[0];
    if (s.approvedAt) {
      sb.approvedAt = s.approvedAt;
      sb.approvedBy = s.approvedBy || me().name;
      sb.feedbackSubmittedAt = s.feedbackSubmittedAt || s.approvedAt;
    }

    return { ...base, comments };
  };

  const touch = () => { if (onChange) onChange(load()); };

  const api = {
    // No-ops: nothing to record, and the presence list is deliberately empty
    // rather than faked. Inventing a colleague who is "also viewing" would be
    // the one thing here that's a lie rather than a sample.
    recordStoryboardViewer: async () => null,
    recordStoryboardView: async () => {},
    submitStoryboardFeedback: async () => {
      store.write({ feedbackSubmittedAt: new Date().toISOString() });
      touch();
      return { ok: true };
    },

    postStoryboardComment: async (_token, payload) => {
      const c = {
        id: rid(),
        versionId: payload.versionId || 'demo-sb-v2',
        parentId: null,
        pageNumber: payload.pageNumber || 1,
        anchorX: payload.anchorX ?? null,
        anchorY: payload.anchorY ?? null,
        body: payload.body || '',
        authorName: me().name,
        authorEmail: me().email,
        createdAt: new Date().toISOString(),
        attachmentUrl: payload.attachmentUrl || null,
        attachmentName: payload.attachmentName || null,
        attachmentType: payload.attachmentType || null,
        mine: true,
      };
      store.write({ comments: [...(store.read().comments || []), c] });
      touch();
      return c;
    },

    editStoryboardComment: async (_token, id, body) => {
      store.write({ edits: { ...(store.read().edits || {}), [id]: body } });
      touch();
      return { id, body };
    },

    deleteStoryboardComment: async (_token, id) => {
      const s = store.read();
      store.write({
        removed: [...(s.removed || []), id],
        comments: (s.comments || []).filter((c) => c.id !== id),
      });
      touch();
      return { ok: true };
    },

    approveStoryboard: async (_token, _storyboardId, approvedBy) => {
      const at = new Date().toISOString();
      store.write({ approvedAt: at, approvedBy: approvedBy || me().name, feedbackSubmittedAt: at });
      touch();
      return { approvedAt: at, feedbackSubmittedAt: at };
    },

    // Attachments resolve to a local object URL. It works for the length of the
    // tour and costs no storage — uploading a stranger's file to our blob store
    // from a demo would be a real cost and a real liability for a fake project.
    uploadStoryboardAsset: async (_token, file) => ({
      url: URL.createObjectURL(file),
      name: file.name,
      type: file.type || null,
    }),

    pollPublicStoryboard: async () => load(),
  };

  return { api, load, seedIds: DEMO_SB_SEED_COMMENT_IDS };
}
