import { describe, it, expect } from 'vitest';
import {
  inlineEmojiImages, isHtmlEmpty, EMAIL_HTML_SANITIZE, CAMPAIGN_HTML_SANITIZE,
} from '../src/lib/emailHtml.js';

// DOMPurify itself needs a browser DOM, which this suite doesn't have — these
// cover the pure pieces and the shape of the allowlists, which is where the
// bugs actually were.

describe('emoji pasted as images', () => {
  it('becomes the character, so it survives an editor that strips images', () => {
    expect(inlineEmojiImages('<li><img class="emoji" src="https://cdn/1f393.png" alt="🎓"> Training</li>'))
      .toBe('<li>🎓 Training</li>');
  });

  it('handles the multi-codepoint ones', () => {
    expect(inlineEmojiImages('<img src="x" alt="👍🏽">')).toBe('👍🏽');
    expect(inlineEmojiImages('<img src="x" alt="👩‍💻">')).toBe('👩‍💻');
  });

  it('leaves a real image alone', () => {
    // An actual picture must not be replaced by its caption.
    const img = '<img src="https://app.squideo.com/api/campaign-image?i=abc" alt="Our team">';
    expect(inlineEmojiImages(img)).toBe(img);
  });

  it('leaves an image with no alt alone', () => {
    const img = '<img src="https://x/y.png">';
    expect(inlineEmojiImages(img)).toBe(img);
  });
});

describe('what counts as an empty draft', () => {
  it('does not call an image nothing', () => {
    // A campaign that's a picture and a button used to read as empty, which
    // left the send button disabled with no explanation.
    expect(isHtmlEmpty('<p><img src="https://x/y.png"></p>')).toBe(false);
  });

  it('still recognises a genuinely blank one', () => {
    expect(isHtmlEmpty('<p><br></p>')).toBe(true);
    expect(isHtmlEmpty('<div>&nbsp;</div>')).toBe(true);
    expect(isHtmlEmpty('')).toBe(true);
  });
});

describe('the two allowlists', () => {
  it('lets a campaign use the things an email needs to look like an email', () => {
    ['img', 'h1', 'h2', 'table', 'tr', 'td', 'blockquote'].forEach((tag) => {
      expect(CAMPAIGN_HTML_SANITIZE.ALLOWED_TAGS).toContain(tag);
    });
    ['src', 'alt', 'width', 'bgcolor'].forEach((attr) => {
      expect(CAMPAIGN_HTML_SANITIZE.ALLOWED_ATTR).toContain(attr);
    });
  });

  it('keeps the everyday composer as narrow as it was', () => {
    ['img', 'h1', 'table'].forEach((tag) => {
      expect(EMAIL_HTML_SANITIZE.ALLOWED_TAGS).not.toContain(tag);
    });
  });

  it('widens what an email can LOOK like, never what it can DO', () => {
    // The security boundary must be identical in both modes.
    ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta', 'base']
      .forEach((tag) => {
        expect(CAMPAIGN_HTML_SANITIZE.ALLOWED_TAGS).not.toContain(tag);
        expect(EMAIL_HTML_SANITIZE.ALLOWED_TAGS).not.toContain(tag);
      });
    CAMPAIGN_HTML_SANITIZE.ALLOWED_ATTR.forEach((attr) => {
      expect(attr.toLowerCase().startsWith('on')).toBe(false);
    });
  });
});
