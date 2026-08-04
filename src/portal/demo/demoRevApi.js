// The sample project's data layer: the same method signatures as the real
// `revApi` in Review.jsx, backed by memory plus sessionStorage instead of the
// network. VideoRevision can't tell the difference, which is the point — a
// prospect is driving the real review surface, not a facsimile of it.
//
// sessionStorage rather than localStorage: a comment they leave should survive
// a page refresh mid-tour, but their sample project should be clean again next
// visit. A demo that slowly fills up with a stranger's old test comments stops
// looking like a demo and starts looking like a bug.

import { buildDemoData, DEMO_SEED_COMMENT_IDS } from './fixtures.js';

const STORE_KEY = 'sq_demo_review';
const rid = () => 'demo-' + Math.random().toString(36).slice(2, 10);

function readStore() {
  try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null') || {}; }
  catch { return {}; }
}
function writeStore(patch) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), ...patch }));
  } catch { /* private mode — the in-memory copy still works for this page */ }
}
export function resetDemo() {
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

// Returns { api, load } — `load` builds the current payload, `api` mutates it.
// `onChange` is called after every mutation so the page can re-render, mirroring
// how the real page re-polls after a write.
export function createDemoRevApi({ config, identity, onChange }) {
  const me = () => ({
    name: identity?.name || 'You',
    email: (identity?.email || 'you@example.com').toLowerCase(),
  });

  const load = () => {
    const base = buildDemoData(config);
    const s = readStore();
    const added = Array.isArray(s.comments) ? s.comments : [];
    const removed = new Set(Array.isArray(s.removed) ? s.removed : []);
    const edits = s.edits || {};

    const comments = [...base.comments, ...added]
      .filter((c) => !removed.has(c.id))
      .map((c) => (edits[c.id] ? { ...c, body: edits[c.id] } : c))
      // Their own comments are marked `mine` so the real edit/delete affordances
      // appear — without it the demo silently hides half the interface.
      .map((c) => ({ ...c, mine: !!c.authorEmail && c.authorEmail === me().email }));

    const video = base.videos[0];
    if (s.approvedAt) {
      video.approvedAt = s.approvedAt;
      video.approvedBy = s.approvedBy || me().name;
    }
    if (s.feedbackSubmittedAt) video.feedbackSubmittedAt = s.feedbackSubmittedAt;

    return { ...base, comments };
  };

  const touch = () => { if (onChange) onChange(load()); };

  const api = {
    // No-ops: nothing to record, and the presence list is deliberately empty
    // rather than faked. Inventing a colleague who is "also viewing" would be
    // the one thing here that's a lie rather than a sample.
    recordRevisionViewer: async () => null,
    recordRevisionView: async () => {},
    submitRevisionFeedback: async () => {
      writeStore({ feedbackSubmittedAt: new Date().toISOString() });
      touch();
      return { ok: true };
    },

    postRevisionComment: async (_token, payload) => {
      const c = {
        id: rid(),
        versionId: payload.versionId || 'demo-v2',
        parentId: payload.parentId || null,
        timecodeSeconds: payload.timecodeSeconds ?? null,
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
      writeStore({ comments: [...(readStore().comments || []), c] });
      touch();
      return c;
    },

    editRevisionComment: async (_token, id, body) => {
      writeStore({ edits: { ...(readStore().edits || {}), [id]: body } });
      touch();
      return { ok: true };
    },

    deleteRevisionComment: async (_token, id) => {
      const s = readStore();
      writeStore({
        removed: [...(s.removed || []), id],
        comments: (s.comments || []).filter((c) => c.id !== id),
      });
      touch();
      return { ok: true };
    },

    approveRevision: async (_token, _videoId, approvedBy) => {
      writeStore({ approvedAt: new Date().toISOString(), approvedBy: approvedBy || me().name });
      touch();
      return { ok: true };
    },

    // Attachments resolve to a local object URL. It works for the length of the
    // tour and costs no storage — uploading a stranger's file to our blob store
    // from a demo would be a real cost and a real liability for a fake project.
    uploadRevisionAsset: async (_token, file) => ({
      url: URL.createObjectURL(file),
      name: file.name,
      type: file.type || null,
    }),

    pollPublicRevision: async () => load(),
  };

  return { api, load, seedIds: DEMO_SEED_COMMENT_IDS };
}
