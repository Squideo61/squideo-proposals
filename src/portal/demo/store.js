// Scratch storage for the sample project, shared by the video and storyboard
// demo APIs.
//
// sessionStorage rather than localStorage: a comment they leave should survive
// a page refresh mid-tour, but their sample project should be clean again next
// visit. A demo that slowly fills up with a stranger's old test comments stops
// looking like a demo and starts looking like a bug.

export const REVIEW_KEY = 'sq_demo_review';
export const STORYBOARD_KEY = 'sq_demo_storyboard';

const KEYS = [REVIEW_KEY, STORYBOARD_KEY];

// A tiny read/write pair over one key. Every write is a merge, so a caller only
// has to name the field it's changing.
export function makeDemoStore(key) {
  const read = () => {
    try { return JSON.parse(sessionStorage.getItem(key) || 'null') || {}; }
    catch { return {}; }
  };
  const write = (patch) => {
    try { sessionStorage.setItem(key, JSON.stringify({ ...read(), ...patch })); }
    catch { /* private mode — the in-memory copy still works for this page */ }
  };
  return { read, write };
}

// "Start over" wipes both stages, not just the one they're looking at. A reset
// that left the other stage half-finished would be the confusing kind.
export function resetDemo() {
  KEYS.forEach((k) => {
    try { sessionStorage.removeItem(k); } catch { /* ignore */ }
  });
}

// What the visitor has actually done, for the ticks on the overview screen.
// "Tried" means they left a comment or finalised — opening a stage and looking
// at it doesn't count, because the point of the tour is doing rather than
// watching.
export function demoProgress() {
  const read = (key) => {
    try { return JSON.parse(sessionStorage.getItem(key) || 'null') || {}; }
    catch { return {}; }
  };
  const stage = (key) => {
    const s = read(key);
    const comments = Array.isArray(s.comments) ? s.comments.length : 0;
    return { comments, finalised: !!s.approvedAt, tried: comments > 0 || !!s.approvedAt };
  };
  return { video: stage(REVIEW_KEY), storyboard: stage(STORYBOARD_KEY) };
}
