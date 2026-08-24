import { describe, it, expect } from 'vitest';
import { buildHash, isPlainLeftClick } from '../src/lib/routes.js';

describe('a view as a URL', () => {
  it('matches what navigation actually pushes', () => {
    // The href and the pushState have to agree, or a new tab lands somewhere
    // other than where a click would have gone.
    expect(buildHash('marketing', 'email')).toBe('#/marketing/email');
    expect(buildHash('pipeline')).toBe('#/pipeline');
    expect(buildHash('deal', 'deal_123')).toBe('#/deal/deal_123');
  });

  it('keeps the list view at the root', () => {
    expect(buildHash('list')).toBe('#/');
  });

  it('encodes an id that would otherwise break the URL', () => {
    expect(buildHash('partner-credit-detail', 'a/b c')).toBe('#/partner-credit-detail/a%2Fb%20c');
  });
});

describe('which clicks the browser keeps', () => {
  const click = (over = {}) => ({ button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });

  it('takes over an ordinary left click, so navigation stays in-app', () => {
    expect(isPlainLeftClick(click())).toBe(true);
  });

  it('leaves ctrl/cmd-click alone — that is a new tab', () => {
    expect(isPlainLeftClick(click({ ctrlKey: true }))).toBe(false);
    expect(isPlainLeftClick(click({ metaKey: true }))).toBe(false);
  });

  it('leaves shift-click alone — that is a new window', () => {
    expect(isPlainLeftClick(click({ shiftKey: true }))).toBe(false);
  });

  it('leaves alt-click alone — that is a download', () => {
    expect(isPlainLeftClick(click({ altKey: true }))).toBe(false);
  });

  it('leaves middle-click alone', () => {
    expect(isPlainLeftClick(click({ button: 1 }))).toBe(false);
  });

  it('does not fight a handler that already dealt with the click', () => {
    expect(isPlainLeftClick(click({ defaultPrevented: true }))).toBe(false);
  });
});
