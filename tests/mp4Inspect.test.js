import { describe, it, expect } from 'vitest';
import { inspectMp4Boxes, bitrateMbps } from '../src/lib/mp4Inspect.js';

// An MP4 is a flat list of [4-byte size][4-byte type] boxes. Whether `moov`
// (the seek index) comes before `mdat` (the frames) decides if a browser can
// scrub the file or has to drag the whole thing down first.

// Build a byte-reader over a synthetic box layout: [[type, size, declaredSize?], …].
// declaredSize lets a test write a bogus length without shrinking the buffer.
function layout(boxes, { sixtyFour = false } = {}) {
  const total = boxes.reduce((n, [, size]) => n + size, 0);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let off = 0;
  for (const [type, size, declared] of boxes) {
    const wire = declared ?? size;
    if (sixtyFour) {
      view.setUint32(off, 1);                    // marker: 64-bit size follows
      view.setUint32(off + 8, 0);                // high word
      view.setUint32(off + 12, wire);            // low word
    } else {
      view.setUint32(off, wire);
    }
    for (let i = 0; i < 4; i++) view.setUint8(off + 4 + i, type.charCodeAt(i));
    off += size;
  }
  const read = async (offset, length) => {
    if (offset >= total) return null;
    return new DataView(buf.buffer, offset, Math.min(length, total - offset));
  };
  return { read, total };
}

const walk = (boxes, opts) => {
  const { read, total } = layout(boxes, opts);
  return inspectMp4Boxes(read, total);
};

describe('inspectMp4Boxes', () => {
  it('reports faststart when moov precedes mdat — the web-optimised export', async () => {
    const r = await walk([['ftyp', 32], ['moov', 2048], ['mdat', 4096]]);
    expect(r).toEqual({ container: 'mp4', faststart: true });
  });

  it('reports NOT faststart when mdat comes first — the Premiere default', async () => {
    const r = await walk([['ftyp', 32], ['mdat', 40960], ['moov', 2048]]);
    expect(r).toEqual({ container: 'mp4', faststart: false });
  });

  it('skips the filler boxes an exporter leaves behind', async () => {
    const r = await walk([['ftyp', 32], ['free', 64], ['wide', 16], ['moov', 512], ['mdat', 8192]]);
    expect(r.faststart).toBe(true);
  });

  it('handles 64-bit box sizes — the large-file encoding', async () => {
    const r = await walk([['ftyp', 32], ['mdat', 4096], ['moov', 512]], { sixtyFour: true });
    expect(r.faststart).toBe(false);
  });

  it('declines to judge a container that is not MP4', async () => {
    const r = await walk([['xxxx', 64], ['yyyy', 64]]);
    expect(r).toEqual({ container: 'other', faststart: null });
  });

  it('gives up rather than guessing on a malformed box size', async () => {
    // A size smaller than the header itself would loop forever if trusted.
    const r = await walk([['ftyp', 32], ['free', 16, 4]]);
    expect(r.faststart).toBe(null);
  });

  it('stops walking instead of scanning a whole file of filler', async () => {
    const many = Array.from({ length: 40 }, () => ['free', 16]);
    const r = await walk([['ftyp', 32], ...many, ['moov', 64]]);
    // Bounded by maxBoxes — an answer we can't reach cheaply is "don't know".
    expect(r.faststart).toBe(null);
  });
});

describe('bitrateMbps', () => {
  it('flags the real case: 28MB for a 3:36 explainer', () => {
    // What the Network panel showed — ~1.05 Mbps would be normal for flat 2D.
    expect(bitrateMbps(28_354_000, 216)).toBeCloseTo(1.05, 1);
  });

  it('computes a sane 1080p animation export', () => {
    expect(bitrateMbps(2_500_000, 10)).toBe(2);
  });

  it('returns null when it cannot know', () => {
    expect(bitrateMbps(0, 10)).toBe(null);
    expect(bitrateMbps(1000, 0)).toBe(null);
    expect(bitrateMbps(1000, null)).toBe(null);
  });
});
