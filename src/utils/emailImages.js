import DOMPurify from 'dompurify';

// Rewrite an email image src so it actually loads in a browser:
//   - absolute http(s) → our same-origin proxy (/api/email-image), so
//     ad/tracker blockers and third-party CDN reputation can't block it (the
//     trick Gmail uses by proxying every remote image);
//   - cid: inline-attachment refs → /api/crm/gmail/inline-image, which pulls the
//     embedded bytes from Gmail (needs the message id — browsers/CSP can't load
//     cid: at all);
//   - data:, blob:, relative → left untouched.
const rewriteEmailImageSrc = (src, messageId) => {
  const s = (src || '').trim();
  if (/^cid:/i.test(s)) {
    if (!messageId) return src; // can't resolve an inline ref without the message
    const cid = s.replace(/^cid:/i, '').replace(/^<|>$/g, '');
    return '/api/crm/gmail/inline-image?messageId=' + encodeURIComponent(messageId)
      + '&cid=' + encodeURIComponent(cid);
  }
  if (/^https?:\/\//i.test(s)) return '/api/email-image?u=' + encodeURIComponent(s);
  return src;
};

// Exposed for callers that build an <img> src outside the sanitizer.
export const proxiedEmailImageUrl = (src) => rewriteEmailImageSrc(src, null);

// DOMPurify.sanitize for an email body being DISPLAYED, with a temporary hook
// that routes every <img> (and srcset candidate) through the image proxy /
// inline-image resolver and hardens loading. The hook is registered only for
// this call and removed immediately after, so other sanitize() callers —
// crucially the reply-quote/compose path, whose output is sent to real
// recipients and must keep original image URLs — are never affected.
//
// `opts.messageId` enables cid: inline-image resolution for that message.
export const sanitizeEmailBody = (html, config, opts = {}) => {
  const messageId = opts.messageId || null;
  const hook = (node) => {
    if (node.nodeName !== 'IMG') return;
    const src = node.getAttribute('src');
    if (src) {
      const rewritten = rewriteEmailImageSrc(src, messageId);
      if (rewritten !== src) node.setAttribute('src', rewritten);
    }
    const srcset = node.getAttribute('srcset');
    if (srcset) {
      const rewritten = srcset.split(',').map((part) => {
        const seg = part.trim();
        if (!seg) return seg;
        const sp = seg.indexOf(' ');
        const url = sp === -1 ? seg : seg.slice(0, sp);
        const descriptor = sp === -1 ? '' : seg.slice(sp);
        return rewriteEmailImageSrc(url, messageId) + descriptor;
      }).filter(Boolean).join(', ');
      node.setAttribute('srcset', rewritten);
    }
    node.setAttribute('referrerpolicy', 'no-referrer');
    node.setAttribute('loading', 'lazy');
    node.setAttribute('decoding', 'async');
  };
  DOMPurify.addHook('afterSanitizeAttributes', hook);
  try {
    return DOMPurify.sanitize(html || '', config);
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
};
