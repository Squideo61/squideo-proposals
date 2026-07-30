// "Invite to portal" opens a real, editable email in the composer rather than
// firing the system invite. The copy comes from an ordinary saved template
// (seeded server-side as tpl_portal_invite, see api/_lib/crm/templates.js), so
// it's edited in the composer's template panel like any other.
//
// The one thing the template can't know is the invite link, which is minted per
// invite — hence the placeholders below.

export const PORTAL_INVITE_TEMPLATE_ID = 'tpl_portal_invite';

// Only used if the seeded template has been deleted. Deliberately terse — the
// good copy lives in the template, which is the editable one.
const FALLBACK = {
  subject: 'Your Squideo client portal is ready',
  bodyHtml: `<p>Hi {{first_name}},</p>
<p>Your Squideo client portal is ready — track progress, review videos and download the finished films.</p>
<p><a href="{{portal_link}}">Set up your login here</a></p>`,
};

export function portalInviteTemplate(templates) {
  const t = (templates || []).find((x) => x.id === PORTAL_INVITE_TEMPLATE_ID);
  if (!t) return FALLBACK;
  return {
    subject: t.subject || FALLBACK.subject,
    bodyHtml: t.bodyHtml || FALLBACK.bodyHtml,
  };
}

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

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// Fill the placeholders. An unknown placeholder is left alone rather than
// blanked, so a typo in the template is visible instead of silently swallowed.
// Body values are HTML-escaped (a company name with an ampersand shouldn't
// break the message, and the link has to survive being an href); the subject is
// plain text, so it takes the raw value.
// The signature is appended to the draft, not part of the template. Marking it
// means "save as template" can drop it precisely, rather than trying to match
// signature HTML that contentEditable may have reformatted.
export const SIGNATURE_MARKER = 'data-sq-signature';

export function wrapSignature(html) {
  return html ? `<div ${SIGNATURE_MARKER}="1">${html}</div>` : '';
}

// The reverse of fillPortalInvite: take an edited DRAFT and turn it back into a
// template. Without this, saving Dan's draft would bake "Hi Dan", his company
// and — worst of all — his one-time invite link into the copy every future
// client receives.
//
// Values are put back in the order they were substituted, longest first, so a
// company name that contains the first name is matched as the company. Both the
// raw and HTML-escaped forms are tried, since the body carries the escaped one.
export function unfillPortalInvite(html, vars) {
  // The signature was appended last, so everything from its marker on goes.
  let out = String(html || '').replace(
    new RegExp(`<div[^>]*${SIGNATURE_MARKER}[\\s\\S]*$`, 'i'), '',
  );

  const subs = [
    [vars.inviteUrl, 'portal_link'],
    [vars.email, 'email'],
    [vars.companyName, 'company'],
    [firstNameFor(vars), 'first_name'],
  ].filter(([value]) => value && String(value).trim());

  for (const [value, key] of subs) {
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

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function fillPortalInvite(template, vars) {
  const map = {
    portal_link: vars.inviteUrl || '',
    first_name: firstNameFor(vars),
    name: vars.name || vars.email || '',
    email: vars.email || '',
    company: vars.companyName || 'your organisation',
    sender: vars.senderName || 'The Squideo team',
  };
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
