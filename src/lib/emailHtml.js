// Shared between the CRM's full email composer, the portal's invite composer
// and the campaign composer. Deliberately one copy: a second, looser sanitiser
// on another send path is exactly the kind of drift that ships an XSS to a
// client's inbox.
import DOMPurify from 'dompurify';

// What survives into an outgoing email. Deliberately narrow: enough for a
// pasted signature and basic formatting, nothing that executes or loads.
const BASE_TAGS = ['b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'p', 'br', 'span', 'div', 'font'];
const BASE_ATTR = ['href', 'target', 'rel', 'style', 'color'];

// Extra tags a CAMPAIGN may use. Presentational only — this widens what an
// email can LOOK like, never what it can DO: no script, style, iframe, object,
// embed, form or event handlers, in either mode.
//
// Without these, a marketing email is a wall of paragraphs: headings flatten to
// plain text, a call-to-action button (a table, because Outlook ignores padding
// on links) collapses to an underlined sentence, and every image — including
// the emoji some editors paste AS images — disappears silently.
const RICH_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'img', 'hr', 'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
];
const RICH_ATTR = [
  'src', 'alt', 'width', 'height', 'align', 'valign',
  'bgcolor', 'cellpadding', 'cellspacing', 'border', 'role',
];

export const EMAIL_HTML_SANITIZE = { ALLOWED_TAGS: BASE_TAGS, ALLOWED_ATTR: BASE_ATTR };
export const CAMPAIGN_HTML_SANITIZE = {
  ALLOWED_TAGS: [...BASE_TAGS, ...RICH_TAGS],
  ALLOWED_ATTR: [...BASE_ATTR, ...RICH_ATTR],
};

// An emoji pasted from a document or a chat app often arrives as an <img> with
// the character itself in the alt text. Turning it back into the character is
// better than keeping the image on both counts: it can't break when someone
// else's CDN moves, and it renders in clients that block remote images — which
// is most of them, before the reader clicks "show images".
const EMOJI_IMG = /<img\b[^>]*\balt\s*=\s*(["'])([^"']{1,8})\1[^>]*>/gi;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️]+$/u;

export function inlineEmojiImages(html) {
  return String(html || '').replace(EMOJI_IMG, (whole, _q, alt) => {
    try { return EMOJI_ONLY.test(alt) ? alt : whole; }
    catch { return whole; }
  });
}

// `rich` opts into the campaign tag set. It also drops the default-font wrapper,
// because a campaign is rendered inside the branded template which sets its own
// typography — wrapping it again just overrides that with 14px grey.
export function sanitizeEmailHtml(html, { rich = false } = {}) {
  const input = rich ? inlineEmojiImages(html) : html;
  const clean = DOMPurify.sanitize(input || '', rich ? CAMPAIGN_HTML_SANITIZE : EMAIL_HTML_SANITIZE);
  if (rich) return clean;
  // Wrap so recipients get a sensible default font/size/colour even if the
  // body has no block wrapper of its own.
  return '<div style="font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:1.6;color:#0F2A3D;">'
    + clean + '</div>';
}

// Plain-text fallback for the multipart/alternative text part: turn block ends
// and <br> into newlines, strip the rest, decode entities.
export function htmlToPlainText(html) {
  if (!html) return '';
  const withBreaks = String(html)
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const ta = document.createElement('textarea');
  ta.innerHTML = withBreaks;
  return ta.value.replace(/\n{3,}/g, '\n\n').trim();
}

export function isHtmlEmpty(html) {
  if (!html) return true;
  // An image is content even though it contributes no text — without this, a
  // campaign that is a picture and a button reads as an empty draft and the
  // send button stays disabled.
  if (/<img\b/i.test(html)) return false;
  const stripped = String(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, '').replace(/\s/g, '');
  return stripped.length === 0;
}
