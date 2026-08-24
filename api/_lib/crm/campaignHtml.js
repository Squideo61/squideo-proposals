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

// ── the brand ───────────────────────────────────────────────────────────────
// Kept here as plain values rather than imported from the app's theme: this
// file is the one thing rendering into other people's inboxes, and an email
// must not change its appearance because a UI token was retuned.
const INK = '#0F2A3D';      // Squideo navy
const CYAN = '#2BB8E6';     // Squideo blue
const PAPER = '#F4F6F8';
const BORDER = '#E5E9EE';
const MUTED = '#5C6B77';

// The logo has to be a hosted image. Every mail client strips data: URIs (which
// is what the app itself uses), so this is the same artwork written out to
// public/squideo-logo-email.png at 243×96 and shown at half that for sharpness
// on retina screens. It is white artwork on transparency, so it sits on the
// navy bar rather than on white.
const APP = (process.env.APP_URL || 'https://app.squideo.com').replace(/\/$/, '');
const LOGO_URL = `${APP}/squideo-logo-email.png`;

const SITE_URL = 'https://squideo.com';
const PHONE = '01482 738 656';

// Wraps an instrumented body in the Squideo email chrome.
//
// `unsubscribeUrl` is required for a real send — a marketing email without a
// visible opt-out is a PECR problem, so the footer is part of the wrapper
// rather than something a sender has to remember to paste in. The preview
// passes a '#' placeholder.
//
// Table-based and inline-styled on purpose. This has to survive Outlook, which
// renders with Word: no flexbox, no grid, no shorthand backgrounds, and every
// dimension stated. The <style> block on top is a progressive enhancement for
// the clients that honour it (phones especially) — nothing depends on it.
export function wrapCampaignHtml({ bodyHtml, preheader = '', unsubscribeUrl = '#', showFooter = true }) {
  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Squideo</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  /* Typography for whatever the sender typed into the composer. Set here so a
     pasted paragraph looks like the rest of the email instead of like Times
     New Roman. */
  .sq-body h1 { font-size:24px; line-height:1.25; margin:0 0 14px; font-weight:800; color:${INK}; }
  .sq-body h2 { font-size:19px; line-height:1.3; margin:22px 0 10px; font-weight:700; color:${INK}; }
  .sq-body h3 { font-size:16px; line-height:1.35; margin:20px 0 8px; font-weight:700; color:${INK}; }
  .sq-body p  { margin:0 0 14px; }
  .sq-body ul, .sq-body ol { margin:0 0 14px; padding-left:22px; }
  .sq-body li { margin:0 0 6px; }
  .sq-body a  { color:${CYAN}; text-decoration:underline; }
  .sq-body img { max-width:100%; height:auto; border:0; }
  .sq-body blockquote {
    margin:0 0 16px; padding:2px 0 2px 16px;
    border-left:3px solid ${CYAN}; color:${MUTED};
  }
  @media only screen and (max-width:620px) {
    .sq-shell { width:100% !important; }
    .sq-pad { padding-left:22px !important; padding-right:22px !important; }
    .sq-body h1 { font-size:21px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAPER};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};-webkit-font-smoothing:antialiased;">
  ${preheaderBlock(preheader)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
    <tr><td align="center" style="padding:26px 12px;">

      <table role="presentation" class="sq-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${BORDER};">

        <!-- Header: the logo is white artwork, so it needs the navy behind it. -->
        <tr><td align="center" style="background:${INK};padding:22px 30px;">
          <img src="${LOGO_URL}" width="122" height="48" alt="Squideo"
               style="display:block;width:122px;height:48px;border:0;outline:none;text-decoration:none;">
        </td></tr>
        <!-- Brand rule: one line of cyan, doing the work a whole banner would. -->
        <tr><td style="background:${CYAN};font-size:0;line-height:0;height:4px;">&nbsp;</td></tr>

        <tr><td class="sq-body sq-pad" style="padding:30px;font-size:15px;line-height:1.65;color:${INK};">
          ${bodyHtml}
        </td></tr>

      </table>

      ${showFooter ? `
      <table role="presentation" class="sq-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr><td class="sq-pad" style="padding:18px 30px 6px;text-align:center;font-size:12px;line-height:1.7;color:${MUTED};">
          <a href="${SITE_URL}" style="color:${MUTED};text-decoration:none;font-weight:700;">squideo.com</a>
          &nbsp;·&nbsp;
          <a href="tel:+441482738656" style="color:${MUTED};text-decoration:none;">${PHONE}</a>
          &nbsp;·&nbsp;
          <a href="mailto:enquiries@squideo.co.uk" style="color:${MUTED};text-decoration:none;">enquiries@squideo.co.uk</a>
          <br>
          Squideo Ltd · Hull, United Kingdom
        </td></tr>
        <tr><td style="padding:8px 30px 0;text-align:center;font-size:11.5px;line-height:1.7;color:#8A9BA8;">
          You're receiving this because you've been in touch with Squideo about video.<br>
          <a href="${unsubscribeUrl}" style="color:#8A9BA8;text-decoration:underline;">Unsubscribe</a>
        </td></tr>
      </table>` : ''}

    </td></tr>
  </table>
</body></html>`;
}

// A call-to-action button, as a table rather than a styled <a>: Outlook ignores
// padding on inline elements, so a bare link button collapses to underlined
// text there. Exported so the starter template and any future one agree.
export function ctaButton(label, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;">
  <tr><td align="center" bgcolor="${CYAN}" style="border-radius:8px;">
    <a href="${url}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
  </td></tr>
</table>`;
}

// What a new campaign starts as, instead of an empty white box.
//
// Deliberately a skeleton with the shape of a good email rather than finished
// copy — a headline, one reason for writing, one thing to click, a sign-off —
// with obviously-placeholder text so nobody can send it by accident. The merge
// tag is in it because a personalised opener is the single easiest lift in
// email, and people don't use a feature they have to remember exists.
export const DEFAULT_CAMPAIGN_BODY = `<h1>A headline that says what this is about</h1>
<p>Hi {{first_name|there}},</p>
<p>One or two sentences on why you're writing — the thing that's new, the thing
you've made, or the reason it matters to them this month. Keep it to what you'd
say to someone in person.</p>
<p>Then a line on what they get out of it.</p>
${ctaButton('See our latest work', SITE_URL)}
<p>If it's useful, just hit reply — a real person reads them.</p>
<p>Adam<br><span style="color:${MUTED};">Squideo</span></p>`;
