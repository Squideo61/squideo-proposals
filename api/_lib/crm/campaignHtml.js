// Campaign email rendering — merge tags, the wrapper the body sits in, and the
// plain-text alternative. Pure (no database, no network) so it can be unit
// tested and so the composer's preview and the real send can share it.
//
// Order of operations matters and is fixed here rather than at the call site:
//   merge tags → tracking instrumentation → wrapper (with the footer)
// The unsubscribe link is written INTO the wrapper, after instrumentation, so
// it's the one link in the email that is never rewritten through the click
// tracker. An unsubscribe that depends on our redirector still working is an
// unsubscribe that can fail, and a failed unsubscribe is a spam complaint.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// The tags a sender can type into the body. Kept here so the composer's help
// text and the renderer can't drift apart.
export const MERGE_TAGS = [
  { tag: 'first_name', label: 'First name', hint: 'Sam' },
  { tag: 'name',       label: 'Full name',  hint: 'Sam Taylor' },
  { tag: 'company',    label: 'Company',    hint: 'Acme Ltd' },
  { tag: 'email',      label: 'Email',      hint: 'sam@acme.com' },
];

export function firstNameOf(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  // "sam@acme.com" as a name (the signup form lets it happen) is not a first
  // name — better to fall through to the tag's own fallback than greet someone
  // by their email address.
  return first.includes('@') ? '' : first;
}

// Replace {{tag}} / {{tag|fallback}} with the recipient's values. Values are
// HTML-escaped: a contact called "Smith & Sons <Ltd>" must not be able to
// inject markup into an email going to hundreds of people.
//
// An unknown tag is left EXACTLY as typed. Silently blanking it would let a
// typo ({{firstname}}) ship as an invisible hole in the sentence; leaving it
// visible means the test send shows the mistake.
export function renderMergeTags(html, recipient = {}) {
  if (!html) return '';
  const values = {
    first_name: firstNameOf(recipient.name),
    name: recipient.name || '',
    company: recipient.companyName || '',
    email: recipient.email || '',
  };
  return String(html).replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (whole, rawTag, fallback) => {
    const tag = rawTag.toLowerCase();
    if (!(tag in values)) return whole;
    const v = String(values[tag] || '').trim() || String(fallback ?? '').trim();
    return esc(v);
  });
}

// Defence in depth. The composer already sanitises with DOMPurify before this
// html ever reaches the server, but this body is about to be posted to hundreds
// of external inboxes, so the server does not simply trust what it was handed.
// Strips script/style/iframe/object blocks and inline event handlers.
export function stripUnsafeHtml(html) {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

// A very rough html → text conversion for the text/plain alternative. Worth
// having: a message with no text part scores worse with spam filters, and some
// people genuinely read mail as text.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The preview line most clients show next to the subject. Hidden in the body,
// padded so the client doesn't pull the opening sentence in after it.
function preheaderBlock(preheader) {
  if (!preheader) return '';
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">`
    + `${esc(preheader)}${'&#8199;&#65279;'.repeat(60)}</div>`;
}

// Wraps an instrumented body in the email chrome. `unsubscribeUrl` is required
// for a real send — a marketing email without a visible opt-out is a PECR
// problem, so the footer is part of the wrapper rather than something a sender
// has to remember to paste in. The preview passes a '#' placeholder.
export function wrapCampaignHtml({ bodyHtml, preheader = '', unsubscribeUrl = '#', showFooter = true }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F4F6F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F2A3D;">
  ${preheaderBlock(preheader)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F8;padding:28px 14px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E9EE;">
        <tr><td style="padding:22px 30px 6px;">
          <div style="font-size:19px;font-weight:800;letter-spacing:-0.2px;color:#0F2A3D;">Squideo</div>
        </td></tr>
        <tr><td style="padding:10px 30px 26px;font-size:15px;line-height:1.6;color:#0F2A3D;">
          ${bodyHtml}
        </td></tr>
      </table>
      ${showFooter ? `
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;">
        <tr><td style="padding:16px 30px 4px;text-align:center;font-size:12px;line-height:1.6;color:#7E97A8;">
          Squideo Ltd · Hull, United Kingdom · <a href="tel:+441482738656" style="color:#7E97A8;">01482 738 656</a><br>
          You're receiving this because you've been in touch with Squideo about video.<br>
          <a href="${unsubscribeUrl}" style="color:#5A7A8C;text-decoration:underline;">Unsubscribe</a>
        </td></tr>
      </table>` : ''}
    </td></tr>
  </table>
</body></html>`;
}
