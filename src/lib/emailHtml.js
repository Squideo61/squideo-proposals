// Shared between the CRM's full email composer and the portal's invite
// composer. Deliberately one copy: a second, looser sanitiser on another send
// path is exactly the kind of drift that ships an XSS to a client's inbox.
import DOMPurify from 'dompurify';

// What survives into an outgoing email. Deliberately narrow: enough for a
// pasted signature and basic formatting, nothing that executes or loads.
export const EMAIL_HTML_SANITIZE = {
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'p', 'br', 'span', 'div', 'font'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'style', 'color'],
};

export function sanitizeEmailHtml(html) {
  const clean = DOMPurify.sanitize(html || '', EMAIL_HTML_SANITIZE);
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
  const stripped = String(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, '').replace(/\s/g, '');
  return stripped.length === 0;
}
