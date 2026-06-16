import DOMPurify from 'dompurify';

// Route a remote email image through our same-origin proxy (/api/email-image)
// so ad/tracker blockers and third-party CDN reputation can't stop it from
// rendering — the same approach Gmail takes by proxying every remote image.
// Only absolute http(s) URLs are proxied; data:, cid:, blob: and relative URLs
// are left untouched (cid: inline images can't be proxied and stay as-is).
export const proxiedEmailImageUrl = (src) => {
  const s = (src || '').trim();
  if (!/^https?:\/\//i.test(s)) return src;
  return '/api/email-image?u=' + encodeURIComponent(s);
};

// DOMPurify.sanitize for an email body being DISPLAYED, with a temporary hook
// that points every <img> (and srcset candidate) at the image proxy and hardens
// loading. The hook is registered only for this call and removed immediately
// after, so other sanitize() callers — crucially the reply-quote/compose path,
// whose output is sent to real recipients and must keep original image URLs —
// are never affected.
export const sanitizeEmailBody = (html, config) => {
  const hook = (node) => {
    if (node.nodeName !== 'IMG') return;
    const src = node.getAttribute('src');
    if (src) {
      const proxied = proxiedEmailImageUrl(src);
      if (proxied !== src) node.setAttribute('src', proxied);
    }
    const srcset = node.getAttribute('srcset');
    if (srcset) {
      const rewritten = srcset.split(',').map((part) => {
        const seg = part.trim();
        if (!seg) return seg;
        const sp = seg.indexOf(' ');
        const url = sp === -1 ? seg : seg.slice(0, sp);
        const descriptor = sp === -1 ? '' : seg.slice(sp);
        return proxiedEmailImageUrl(url) + descriptor;
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
