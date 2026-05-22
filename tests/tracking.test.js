import { describe, it, expect } from 'vitest';
import { instrumentHtml, newTrackingToken, TRANSPARENT_GIF } from '../api/_lib/crm/trackingHtml.js';

const BASE = 'https://app.squideo.com';

describe('instrumentHtml', () => {
  it('appends an open pixel pointing at the token', () => {
    const { html } = instrumentHtml('<p>Hi</p>', 'tok123');
    expect(html).toContain(`${BASE}/api/track/open?t=tok123`);
    expect(html).toMatch(/width="1" height="1"/);
  });

  it('rewrites http(s) links through the click endpoint and records originals', () => {
    const { html, links } = instrumentHtml(
      '<a href="https://example.com/a">A</a> and <a href="http://foo.test/b?x=1">B</a>',
      'tok',
    );
    expect(links).toEqual(['https://example.com/a', 'http://foo.test/b?x=1']);
    expect(html).toContain(`href="${BASE}/api/track/click?t=tok&l=0"`);
    expect(html).toContain(`href="${BASE}/api/track/click?t=tok&l=1"`);
    // original destinations no longer appear as hrefs
    expect(html).not.toContain('href="https://example.com/a"');
  });

  it('leaves mailto:, tel: and anchor links untouched', () => {
    const { html, links } = instrumentHtml(
      '<a href="mailto:a@b.com">mail</a> <a href="#top">top</a> <a href="tel:123">call</a>',
      'tok',
    );
    expect(links).toHaveLength(0);
    expect(html).toContain('href="mailto:a@b.com"');
    expect(html).toContain('href="#top"');
    expect(html).toContain('href="tel:123"');
  });

  it('does not double-wrap already-tracked links', () => {
    const already = `<a href="${BASE}/api/track/click?t=x&l=0">x</a>`;
    const { html, links } = instrumentHtml(already, 'tok');
    expect(links).toHaveLength(0);
    expect(html).toContain(already);
  });

  it('handles single-quoted href attributes', () => {
    const { html, links } = instrumentHtml("<a href='https://example.com'>x</a>", 'tok');
    expect(links).toEqual(['https://example.com']);
    expect(html).toContain(`href='${BASE}/api/track/click?t=tok&l=0'`);
  });

  it('no-ops on empty/missing html', () => {
    expect(instrumentHtml('', 'tok')).toEqual({ html: '', links: [] });
    expect(instrumentHtml(null, 'tok')).toEqual({ html: null, links: [] });
  });
});

describe('newTrackingToken', () => {
  it('returns a 32-char hex token, unique per call', () => {
    const a = newTrackingToken();
    const b = newTrackingToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('TRANSPARENT_GIF', () => {
  it('is a valid GIF buffer', () => {
    expect(Buffer.isBuffer(TRANSPARENT_GIF)).toBe(true);
    expect(TRANSPARENT_GIF.slice(0, 3).toString('ascii')).toBe('GIF');
  });
});
