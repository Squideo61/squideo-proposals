// The "finish your quote" link is built from two values an anonymous caller
// supplies — which site the form is on, and which page — and lands in an email
// sent to an address that same caller chose. Both halves are a security
// boundary, not a convenience: without the checks, "email me a link" is a way to
// make Squideo send a stranger a link to any domain they like.
import { describe, it, expect } from 'vitest';
import { buildResumeUrl } from '../api/_lib/quoteResumeEmail.js';

const ALLOWED = [
  'https://app.squideo.com',
  'https://www.squideo.com',
  'https://squideo.com',
];
const build = (origin, path, id = 'form_123') =>
  buildResumeUrl({
    origin,
    path,
    formSessionId: id,
    allowedOrigins: ALLOWED,
    fallbackOrigin: 'https://app.squideo.com',
  });

describe('the origin', () => {
  it('keeps one that is on the list', () => {
    expect(build('https://www.squideo.com', '/get-quote'))
      .toBe('https://www.squideo.com/get-quote?resume=form_123');
  });

  it('tolerates a trailing slash', () => {
    expect(build('https://www.squideo.com/', '/get-quote'))
      .toBe('https://www.squideo.com/get-quote?resume=form_123');
  });

  it('falls back for a lookalike domain', () => {
    // The case a suffix match would let through.
    expect(build('https://www.squideo.com.evil.test', '/get-quote'))
      .toBe('https://app.squideo.com/get-quote?resume=form_123');
  });

  it('falls back for anything else, including nothing at all', () => {
    for (const origin of ['https://evil.test', 'http://www.squideo.com', '', null, undefined, 42]) {
      expect(build(origin, '/get-quote')).toBe('https://app.squideo.com/get-quote?resume=form_123');
    }
  });
});

describe('the path', () => {
  it('defaults to the CRM\'s own copy of the form', () => {
    expect(build('https://app.squideo.com', null))
      .toBe('https://app.squideo.com/quote?resume=form_123');
  });

  it('takes a plain path', () => {
    expect(build('https://squideo.com', '/get-quote'))
      .toBe('https://squideo.com/get-quote?resume=form_123');
  });

  it('drops a trailing slash so the URL matches the site\'s canonical form', () => {
    expect(build('https://squideo.com', '/get-quote/'))
      .toBe('https://squideo.com/get-quote?resume=form_123');
  });

  it('refuses a protocol-relative path, which is another origin wearing a slash', () => {
    expect(build('https://squideo.com', '//evil.test/x'))
      .toBe('https://squideo.com/quote?resume=form_123');
  });

  it('refuses a scheme, a bare word, a query and anything with room for one', () => {
    for (const path of ['https://evil.test', 'get-quote', '/get-quote?next=//evil.test', '/a b', '/x#y']) {
      expect(build('https://squideo.com', path)).toBe('https://squideo.com/quote?resume=form_123');
    }
  });

  it('refuses a path long enough to be carrying something', () => {
    expect(build('https://squideo.com', '/' + 'a'.repeat(200)))
      .toBe('https://squideo.com/quote?resume=form_123');
  });
});

describe('the session id', () => {
  it('is encoded, so it cannot add parameters of its own', () => {
    expect(build('https://squideo.com', '/get-quote', 'a&b=c'))
      .toBe('https://squideo.com/get-quote?resume=a%26b%3Dc');
  });
});
