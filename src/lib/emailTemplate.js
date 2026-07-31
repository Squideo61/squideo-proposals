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
