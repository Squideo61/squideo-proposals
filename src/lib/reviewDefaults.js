// Which video/storyboard — and which draft — a client review link opens on.
//
// A share token covers the WHOLE project, not one video, and the public API
// returns the videos in creation order. Taking items[0] therefore opened the
// oldest video on the deal: on a three-video project, an email saying "Video 3
// is ready" landed the client on video 1, usually on a draft they'd already
// signed off. Links now carry an &item= (and optionally &draft=), and where
// they don't, we work out the newest thing the client is actually being asked
// to look at.
//
// Order of preference:
//   1. The exact draft the link names (&draft=), if the viewer may see it.
//   2. The item the link names (&item=), opened on its newest visible draft.
//   3. The most recently sent item still awaiting the client, newest draft.
//   4. Failing that, whichever item has the most recent draft at all.
//   5. Nothing submitted yet — first item, no draft (the empty state).

const stamp = (v) => {
  const t = new Date(v?.createdAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

// The newest draft of an item. The API orders versions newest-first, but a
// deleted-and-reuploaded draft can repeat a version_number, so sort rather
// than trust position.
export function newestVersion(item) {
  const vs = item?.versions || [];
  if (!vs.length) return null;
  return vs.slice().sort((a, b) =>
    (b.versionNumber ?? 0) - (a.versionNumber ?? 0) || stamp(b) - stamp(a))[0];
}

// When was this item last sent something new to look at?
const lastDraftAt = (item) => (item?.versions || []).reduce((m, v) => Math.max(m, stamp(v)), 0);

export function pickReviewDefault(items, { itemId = null, versionId = null, isAwaiting = null } = {}) {
  const list = items || [];
  const on = (item) => ({ itemId: item.id, versionId: newestVersion(item)?.id || null });

  if (versionId) {
    const hit = list.find(it => (it.versions || []).some(v => v.id === versionId));
    if (hit) return { itemId: hit.id, versionId };
  }
  if (itemId) {
    const hit = list.find(it => it.id === itemId);
    // An item with no visible draft (never submitted, or the link points at a
    // draft since pulled) falls through to the newest thing they CAN see —
    // better than an empty screen on a project with a draft waiting.
    if (hit && (hit.versions || []).length) return on(hit);
  }

  const withDrafts = list.filter(it => (it.versions || []).length);
  if (!withDrafts.length) return { itemId: list[0]?.id || null, versionId: null };
  const awaiting = isAwaiting ? withDrafts.filter(isAwaiting) : [];
  const pool = awaiting.length ? awaiting : withDrafts;
  return on(pool.slice().sort((a, b) => lastDraftAt(b) - lastDraftAt(a))[0]);
}
