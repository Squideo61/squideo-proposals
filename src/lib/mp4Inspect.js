// Is this MP4 safe to stream to a client?
//
// Two export mistakes make a video that plays fine on a desktop behave badly in
// a browser, and both are invisible until a client complains:
//
//  1. NOT WEB-OPTIMISED ("faststart"). An MP4 is a flat list of boxes. The index
//     (`moov`) says where every frame lives; the frames themselves are in
//     `mdat`. Premiere/After Effects write `mdat` FIRST by default, so the
//     browser can't map a timestamp to a byte until it has dragged the whole
//     file down — playback stalls and seeking snaps back to the start.
//     Web-optimised exports move `moov` to the front, so seeking is instant.
//  2. WILDLY OVER-BITRATE. Flat 2D animation compresses hard; a 3-minute
//     explainer has no business being 30MB. An oversized file scrubs badly on
//     any connection slower than an office line.
//
// Parsing is header-only — we walk the top-level box headers and stop at the
// first `moov` or `mdat`, so this reads a few hundred bytes, not the file.

// Box header: [4-byte size][4-byte type]. size 1 = 64-bit size follows;
// size 0 = box runs to end of file.
const MP4_BRANDS = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'styp']);

// `read(offset, length)` returns a DataView (or null when it can't). Keeping the
// reader injectable lets the same walk run over a local File before upload and
// over a Range request against an already-uploaded blob.
export async function inspectMp4Boxes(read, totalSize, { maxBoxes = 16 } = {}) {
  let offset = 0;
  let sawKnownBox = false;

  for (let i = 0; i < maxBoxes; i++) {
    if (totalSize && offset + 8 > totalSize) break;
    const head = await read(offset, 16);
    if (!head || head.byteLength < 8) break;

    let boxSize = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let headerSize = 8;

    if (boxSize === 1) {
      if (head.byteLength < 16) break;
      // 64-bit length. Safe in a double well past any real video size.
      boxSize = head.getUint32(8) * 4294967296 + head.getUint32(12);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = totalSize ? totalSize - offset : 0;
    }

    if (MP4_BRANDS.has(type)) sawKnownBox = true;
    // The whole question: which comes first.
    if (type === 'moov') return { container: 'mp4', faststart: true };
    if (type === 'mdat') return { container: 'mp4', faststart: false };
    // A first box that isn't recognisably MP4 means some other container
    // (WebM, QuickTime variant) — not ours to judge.
    if (i === 0 && !sawKnownBox) return { container: 'other', faststart: null };
    if (boxSize < headerSize) break; // malformed — don't guess
    offset += boxSize;
  }
  return { container: sawKnownBox ? 'mp4' : 'other', faststart: null };
}

// Inspect a File/Blob chosen in the browser, before it's uploaded.
export async function inspectVideoFile(file) {
  if (!file || typeof file.slice !== 'function') return null;
  const read = async (offset, length) => {
    try {
      const buf = await file.slice(offset, offset + length).arrayBuffer();
      return buf.byteLength ? new DataView(buf) : null;
    } catch { return null; }
  };
  try {
    const boxes = await inspectMp4Boxes(read, file.size);
    return { ...boxes, sizeBytes: file.size };
  } catch { return null; }
}

// Megabits per second, given bytes and a duration in seconds. The yardstick for
// "is this export sane": flat 2D animation looks pristine at 2-4 Mbps at 1080p,
// so anything far above that is a mis-set export, not a quality choice.
export function bitrateMbps(sizeBytes, durationSeconds) {
  const secs = Number(durationSeconds) || 0;
  const bytes = Number(sizeBytes) || 0;
  if (secs <= 0 || bytes <= 0) return null;
  return (bytes * 8) / secs / 1_000_000;
}

// Read a video file's duration without rendering it, so we can judge bitrate.
export function readVideoDuration(file) {
  return new Promise((resolve) => {
    if (!file || typeof URL === 'undefined' || !URL.createObjectURL) return resolve(null);
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    const done = (v) => { try { URL.revokeObjectURL(url); } catch {} resolve(v); };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    // Never let a stuck decode block an upload.
    setTimeout(() => done(null), 8000);
    el.src = url;
  });
}

// The producer-facing verdict for a chosen file. Returns null when there's
// nothing worth saying — we only interrupt an upload for a real problem.
const BITRATE_WARN_MBPS = 8;

export async function checkVideoForStreaming(file) {
  const info = await inspectVideoFile(file);
  if (!info || info.container !== 'mp4') return null;
  const duration = await readVideoDuration(file);
  const mbps = bitrateMbps(info.sizeBytes, duration);
  const problems = [];
  if (info.faststart === false) problems.push('not-faststart');
  if (mbps != null && mbps > BITRATE_WARN_MBPS) problems.push('high-bitrate');
  if (!problems.length) return null;
  return { ...info, durationSeconds: duration, bitrateMbps: mbps, problems };
}

// Inspect an already-uploaded video over the network. One Range request for the
// head of the file — enough to see whether `moov` or `mdat` comes first, without
// pulling the video itself. Best-effort: returns null if the host refuses the
// range or blocks cross-origin reads, and callers must treat null as "unknown"
// rather than "fine".
export async function inspectVideoUrl(url, { headBytes = 131072 } = {}) {
  if (!url) return null;
  let view;
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${headBytes - 1}` } });
    if (!res.ok && res.status !== 206) return null;
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) return null;
    view = new DataView(buf);
  } catch { return null; }

  // Walk within the bytes we already have; anything beyond is "don't know"
  // rather than another round trip.
  const read = async (offset, length) => {
    if (offset + 8 > view.byteLength) return null;
    return new DataView(view.buffer, offset, Math.min(length, view.byteLength - offset));
  };
  try {
    return await inspectMp4Boxes(read, view.byteLength);
  } catch { return null; }
}
