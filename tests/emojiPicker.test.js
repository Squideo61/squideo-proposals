// The emoji picker's two bits of logic worth pinning down without a DOM:
// the catalogue parse (one bad space in the data and a whole entry becomes an
// unclickable string) and where the panel opens (it's portalled to fixed
// coordinates, so nothing else stops it hanging off the edge of a phone).
import { describe, it, expect } from 'vitest';

const { EMOJI_ENTRIES, panelPosition } = await import('../src/components/EmojiPicker.jsx');

const PANEL_W = 292;
const PANEL_H = 290;
const rect = (left, top, w = 28, h = 24) => ({ left, top, right: left + w, bottom: top + h });

describe('emoji catalogue', () => {
  it('parses every entry into a character and search words', () => {
    expect(EMOJI_ENTRIES.length).toBeGreaterThan(100);
    for (const e of EMOJI_ENTRIES) {
      expect(e.char, JSON.stringify(e)).toBeTruthy();
      // A missing space would swallow the words into the character.
      expect(e.char.length, e.char).toBeLessThanOrEqual(8);
      expect(e.char).not.toMatch(/\s/);
      expect(e.words.trim(), e.char).toBeTruthy();
      expect(e.words).toBe(e.words.toLowerCase());
    }
  });

  it('lists each emoji once', () => {
    const seen = new Set();
    const dupes = EMOJI_ENTRIES.filter((e) => (seen.has(e.char) ? true : (seen.add(e.char), false)));
    expect(dupes.map((d) => d.char)).toEqual([]);
  });

  it('is searchable by the words people would actually type', () => {
    const find = (q) => EMOJI_ENTRIES.find((e) => e.words.split(' ').some((w) => w.startsWith(q)));
    for (const q of ['thumbs', 'tick', 'rocket', 'smile', 'thanks', 'calendar', 'invoice']) {
      expect(find(q), q).toBeTruthy();
    }
  });
});

describe('panelPosition', () => {
  const desktop = { w: 1400, h: 900 };

  it('opens above a toolbar button when there is room', () => {
    const p = panelPosition(rect(300, 600), 'top', 'left', desktop);
    expect(p.top).toBe(600 - PANEL_H - 6);
    expect(p.left).toBe(300);
  });

  it('flips below when the button is near the top of the window', () => {
    const p = panelPosition(rect(300, 40), 'top', 'left', desktop);
    expect(p.top).toBe(70); // rect.bottom + 6
  });

  it('flips above when a bottom-placed panel would run off the foot', () => {
    const p = panelPosition(rect(300, 850), 'bottom', 'left', desktop);
    expect(p.top).toBe(850 - PANEL_H - 6);
  });

  it('hangs a right-aligned panel off the button’s right edge', () => {
    const p = panelPosition(rect(1000, 500), 'top', 'right', desktop);
    expect(p.left).toBe(1028 - PANEL_W);
  });

  it('never leaves the viewport on a phone', () => {
    const phone = { w: 360, h: 640 };
    for (const left of [0, 100, 340]) {
      for (const top of [0, 300, 630]) {
        for (const placement of ['top', 'bottom']) {
          for (const align of ['left', 'right']) {
            const p = panelPosition(rect(left, top), placement, align, phone);
            expect(p.left).toBeGreaterThanOrEqual(8);
            expect(p.left + p.width).toBeLessThanOrEqual(phone.w - 8);
            expect(p.top).toBeGreaterThanOrEqual(8);
          }
        }
      }
    }
  });
});
