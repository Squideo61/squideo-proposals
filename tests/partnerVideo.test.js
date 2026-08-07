// The Partner Programme page embeds whatever URL an admin pastes in.
//
// Getting this wrong is silent: the portal CSP allows exactly three frame hosts
// (youtube, vimeo, loom) and blob storage for media, so a URL parsed into the
// wrong shape renders a black box with no error anyone would see.
import { describe, it, expect } from 'vitest';
import { videoEmbed } from '../src/portal/pages/Partner.jsx';

describe('videoEmbed', () => {
  it('returns nothing when no video is set', () => {
    expect(videoEmbed(null)).toBe(null);
    expect(videoEmbed('')).toBe(null);
    expect(videoEmbed(undefined)).toBe(null);
  });

  describe('Vimeo — where Squideo actually hosts', () => {
    it('turns a share link into the player URL', () => {
      expect(videoEmbed('https://vimeo.com/625502459')).toEqual({
        kind: 'frame',
        src: 'https://player.vimeo.com/video/625502459',
        oembedUrl: 'https://vimeo.com/625502459',
      });
    });
    // The player box is sized from the film's real dimensions (fetched via our
    // oEmbed proxy) so a non-16:9 film isn't letterboxed in black. That lookup
    // needs the ORIGINAL url: an unlisted film's metadata is only readable with
    // its privacy hash, and stripping it would silently fall back to 16:9.
    it('keeps the privacy hash so an unlisted film can still be measured', () => {
      const e = videoEmbed('https://vimeo.com/625502459/a1b2c3d4e5');
      expect(e.oembedUrl).toBe('https://vimeo.com/625502459/a1b2c3d4e5');
      expect(e.src).toBe('https://player.vimeo.com/video/625502459');
    });
    it('builds a canonical lookup url when handed the /video/ form', () => {
      // player.vimeo.com and vimeo.com/video/... are not accepted by the oEmbed
      // proxy, which only takes vimeo.com/<id> — so we rebuild one.
      expect(videoEmbed('https://vimeo.com/video/625502459').oembedUrl)
        .toBe('https://vimeo.com/625502459');
    });
    it('handles the /video/ form', () => {
      expect(videoEmbed('https://vimeo.com/video/625502459').src)
        .toBe('https://player.vimeo.com/video/625502459');
    });
    it('ignores a hash/query the copy button adds', () => {
      expect(videoEmbed('https://vimeo.com/625502459?share=copy#t=10').src)
        .toBe('https://player.vimeo.com/video/625502459');
    });
    it('does not mistake a vimeo profile page for a video', () => {
      // Not a player URL, so it can't go in the frame — and it isn't media we
      // can play either. Offered as a link rather than embedded blank.
      expect(videoEmbed('https://vimeo.com/squideo').kind).toBe('unsupported');
    });
  });

  describe('YouTube', () => {
    it('watch links', () => {
      expect(videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ').src)
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });
    it('youtu.be short links', () => {
      expect(videoEmbed('https://youtu.be/dQw4w9WgXcQ').src)
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });
    it('an already-embed URL is left as an embed, not double-wrapped', () => {
      expect(videoEmbed('https://www.youtube.com/embed/dQw4w9WgXcQ').src)
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });
    it('keeps the timestamp out of the id', () => {
      expect(videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s').src)
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });
  });

  describe('Loom', () => {
    it('share links become embeds', () => {
      expect(videoEmbed('https://www.loom.com/share/abc123def456').src)
        .toBe('https://www.loom.com/embed/abc123def456');
    });
    it('an embed link stays an embed', () => {
      expect(videoEmbed('https://www.loom.com/embed/abc123def456').src)
        .toBe('https://www.loom.com/embed/abc123def456');
    });
  });

  describe('a file we host ourselves', () => {
    it('an uploaded blob plays natively, not in a frame', () => {
      const url = 'https://abc.public.blob.vercel-storage.com/course/partner/1-ben.mp4';
      expect(videoEmbed(url)).toEqual({ kind: 'file', src: url });
    });
    it('a relative path on our own origin plays', () => {
      expect(videoEmbed('/api/portal?action=download&scope=course').kind).toBe('file');
    });
    it('!! an MP4 on somebody else CDN is flagged unsupported, not silently blank', () => {
      // media-src allows 'self' and our blob store only, so a <video> pointed
      // here would render a black box with the error only in the console.
      expect(videoEmbed('https://cdn.example.com/video.mp4').kind).toBe('unsupported');
    });
    it('a lookalike blob host does not pass', () => {
      expect(videoEmbed('https://x.public.blob.vercel-storage.com.evil.example.com/v.mp4').kind).toBe('unsupported');
    });
  });

  it('never emits a frame src outside the CSP allow-list', () => {
    const allowed = ['https://www.youtube.com/', 'https://player.vimeo.com/', 'https://www.loom.com/'];
    const urls = [
      'https://vimeo.com/1', 'https://youtu.be/dQw4w9WgXcQ',
      'https://www.loom.com/share/x1', 'https://evil.example.com/embed/abc',
      'https://vimeo.com.evil.example.com/12345',
    ];
    for (const u of urls) {
      const e = videoEmbed(u);
      if (e.kind === 'frame') {
        expect(allowed.some((a) => e.src.startsWith(a)), `${u} -> ${e.src}`).toBe(true);
      }
    }
  });
});
