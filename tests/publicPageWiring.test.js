// Adding a public page to this app takes four separate edits in three files,
// and missing any one of them fails quietly rather than loudly:
//
//   1. a rollup input in vite.config.js      — or the page 404s in production
//   2. a rewrite in vercel.json              — or the pretty URL 404s
//   3. its own CSP header block              — or it inherits the strict one
//   4. the default block's negative lookahead — or the default block WINS and
//      the page's own frame-ancestors never apply, so the embed silently breaks
//
// (4) is the nasty one: everything looks right, the page loads when you open it
// directly, and it only fails once someone tries to iframe it. This test checks
// all four agree for every public page at once.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const viteConfig = readFileSync(resolve(root, 'vite.config.js'), 'utf8');

// Every standalone public page: the pretty path and the file it maps to.
const PUBLIC_PAGES = [
  { path: '/quote', file: 'quote.html' },
  { path: '/contact', file: 'contact.html' },
  { path: '/portal', file: 'portal.html' },
  { path: '/course', file: 'course.html' },
  { path: '/reviews', file: 'reviews.html' },
  { path: '/brief-start', file: 'brief-start.html' },
];

// The pages the marketing site embeds. These are the ones where the negative
// lookahead actually matters.
const EMBEDDED = ['/quote', '/contact', '/reviews', '/brief-start'];

const headerBlock = (path) =>
  vercel.headers.find((h) => h.source.startsWith(`${path}(`) || h.source === path);

const cspOf = (block) =>
  block?.headers.find((h) => h.key === 'Content-Security-Policy')?.value || '';

const defaultBlock = vercel.headers.find((h) => h.source.includes('(?!api/'));

describe('public page wiring', () => {
  it.each(PUBLIC_PAGES)('$path has a rollup input', ({ file }) => {
    expect(viteConfig).toContain(`'${file}'`);
  });

  it.each(PUBLIC_PAGES)('$path has a rewrite to its html', ({ path, file }) => {
    const rw = vercel.rewrites.find((r) => r.source === path);
    expect(rw, `no rewrite for ${path}`).toBeTruthy();
    expect(rw.destination).toBe(`/${file}`);
  });

  it.each(PUBLIC_PAGES)('$path has its own CSP block', ({ path }) => {
    expect(cspOf(headerBlock(path)), `no CSP block for ${path}`).toContain('default-src');
  });

  it.each(PUBLIC_PAGES)('$path is excluded from the default CSP block', ({ path }) => {
    // A `source` block REPLACES the default block rather than merging with it,
    // so a page missing from this lookahead silently gets the strict default.
    const slug = path.replace(/^\//, '');
    expect(defaultBlock.source, `${path} missing from the negative lookahead`).toContain(slug);
  });
});

describe('embeddable pages', () => {
  it.each(EMBEDDED)('%s lets the marketing site frame it', (path) => {
    const csp = cspOf(headerBlock(path));
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('https://squideo.com');
    expect(csp).toContain('https://*.squideo.com');
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  it.each(EMBEDDED)('%s is servable cross-origin', (path) => {
    const block = headerBlock(path);
    const corp = block.headers.find((h) => h.key === 'Cross-Origin-Resource-Policy');
    expect(corp?.value).toBe('cross-origin');
  });

  it('keeps the app itself un-embeddable', () => {
    // The CRM and the portal must never be frameable — that's clickjacking on
    // an authenticated surface.
    expect(cspOf(defaultBlock)).toContain("frame-ancestors 'none'");
    expect(cspOf(headerBlock('/portal'))).toContain("frame-ancestors 'none'");
  });
});

describe('the brief-start embed', () => {
  it('posts to the app origin and is not sandboxed', () => {
    // Not asserting on the generated snippet's exact text, but on the two
    // properties that break it: a sandbox traps the user in the frame after
    // signup, and the CSP must allow the same-origin fetch the form makes.
    const csp = cspOf(headerBlock('/brief-start'));
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'self'");
  });
});
