// Shared plumbing for the "open a real, editable email prefilled from a saved
// template" composers — the portal invite (src/lib/portalInviteEmail.js) and
// the client review submit (src/lib/reviewEmail.js).
//
// Both do the same two things: fill {{placeholders}} from the record in front
// of the user, and — when they choose to keep their edits — put those values
// back so the saved template stays generic instead of baking one client's name
// and one-time link into every future send.

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A first name for the greeting: from the contact's name where we have one,
// else the local part of the address ("jane.smith@…" → "Jane"), else a neutral
// "there" so a template never renders "Hi ,".
export function firstNameFor({ name, email }) {
  const fromName = String(name || '').trim().split(/\s+/)[0];
  if (fromName) return fromName;
  const local = String(email || '').split('@')[0].split(/[._-]+/)[0];
  if (!local) return 'there';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// The signature is appended to the draft, not part of the template. Marking it
// means "save as template" can drop it precisely, rather than trying to match
// signature HTML that contentEditable may have reformatted.
export const SIGNATURE_MARKER = 'data-sq-signature';

export function wrapSignature(html) {
  return html ? `<div ${SIGNATURE_MARKER}="1">${html}</div>` : '';
}

// Fill the placeholders. An unknown placeholder is left alone rather than
// blanked, so a typo in the template is visible instead of silently swallowed.
// Body values are HTML-escaped (a company name with an ampersand shouldn't
// break the message, and a link has to survive being an href); the subject is
// plain text, so it takes the raw value.
export function fillTemplate(template, map) {
  const apply = (s, escape) => String(s || '').replace(
    /\{\{\s*([a-z_]+)\s*\}\}/gi,
    (whole, key) => {
      const k = key.toLowerCase();
      if (!(k in map)) return whole;
      return escape ? escapeHtml(map[k]) : map[k];
    },
  );
  return {
    subject: apply(template.subject, false),
    bodyHtml: apply(template.bodyHtml, true),
  };
}

// The reverse: take an edited DRAFT and turn it back into a template.
//
// `subs` is [[value, placeholderKey], …] in the order they should be matched —
// longest / most specific first, so a company name containing the first name is
// matched as the company. Both the raw and HTML-escaped forms are tried, since
// the body carries the escaped one.
export function unfillTemplate(html, subs) {
  // The signature was appended last, so everything from its marker on goes.
  let out = String(html || '').replace(
    new RegExp(`<div[^>]*${SIGNATURE_MARKER}[\\s\\S]*$`, 'i'), '',
  );

  for (const [value, key] of subs.filter(([v]) => v && String(v).trim())) {
    for (const form of new Set([String(value), escapeHtml(String(value))])) {
      // Word boundaries only for short human values — a URL has punctuation at
      // both ends that \b would refuse to match.
      const isWordy = /^[\w][\w\s.'&-]*$/.test(form) && form.length < 60;
      const pattern = isWordy
        ? new RegExp(`\\b${escapeRegExp(form)}\\b`, 'g')
        : new RegExp(escapeRegExp(form), 'g');
      out = out.replace(pattern, `{{${key}}}`);
    }
  }
  return out.trim();
}

// Clean up after a placeholder that filled to nothing. The case that matters is
// the greeting: with no name stored in the CRM, "Hi {{first_name}}," has to read
// "Hi" — not "Hi ," and certainly not the raw placeholder. Two passes, because
// the name is often bold, so it leaves an empty <strong> behind as well as the
// comma. A greeting that DID get a name has real text between it and the comma,
// so neither pass touches it.
const EMPTY_INLINE_TAG = /<(b|strong|i|em|u|span|font)\b[^>]*>(?:\s|&nbsp;)*<\/\1>/gi;
const EMPTY_GREETING = /\b(Hi|Hello|Hey|Dear|Good morning|Good afternoon)(?:\s|&nbsp;)*([,!])/gi;

export function tidyGreeting(html) {
  let out = String(html || '');
  // Loop for nesting (<strong><span></span></strong>); a handful of passes is
  // plenty and the guard stops a pathological body spinning.
  for (let i = 0; i < 5; i++) {
    const next = out.replace(EMPTY_INLINE_TAG, '');
    if (next === out) break;
    out = next;
  }
  return out.replace(EMPTY_GREETING, '$1');
}

// Markers that mean "somebody was supposed to type something here": our own
// {{placeholder}} syntax, the [square bracket] convention people type by hand
// into a saved template, and a lone "#" standing in for a number.
//
// Takes PLAIN TEXT, not HTML — a hex colour in a style attribute or a bracketed
// query string in an href is not a blank the client would ever see, and the
// point of this is what the client sees.
const PLACEHOLDER_PATTERNS = [
  /\{\{\s*[a-z_]+\s*\}\}/gi,
  /\[[^\]\n]{1,40}\]/g,
  // A bare hash as its own word, so "#4", "#squideo" and "#2BB8E6" don't count.
  /(?:^|\s)(#)(?=\s|$)/gm,
];

export function findUnfilledPlaceholders(text) {
  const s = String(text || '');
  const found = new Set();
  for (const re of PLACEHOLDER_PATTERNS) {
    for (const m of s.matchAll(re)) found.add((m[1] || m[0]).trim());
  }
  return [...found];
}
