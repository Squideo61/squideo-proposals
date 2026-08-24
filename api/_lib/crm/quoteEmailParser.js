// Reads a website quote-request NOTIFICATION email and pulls the enquiry back
// out of it.
//
// These are the alerts the old Duda site sent us whenever somebody filled the
// form in. They are the only surviving record of years of enquiries that
// predate the CRM — and the important thing about them is that the SENDER IS
// US. Harvesting the From address off one of these gets you your own address,
// which is why the enquirer has to be read out of the body instead:
//
//     CONTACT INFORMATION:
//     👤 Name: Lauren
//     📧 Email: lauren@tb-projects.co.uk
//     📱 Phone: 77758 664 96
//     🏢 Company: TB Projects
//     Opt In? false
//
//     PROJECT DETAILS:
//     📋 Description: We would like to create a 2D animated explainer video…
//     🎬 Video Length:
//
//     TIMELINE & BUDGET:
//     ⏰ Timeline: 6-8 weeks
//     💰 Budget: Unsure - please advise
//
//     📅 Submitted: 2026-02-18T14:00:09.532Z
//
// Pure and DB-free so it can be tested against real message bodies.
//
// Written to be forgiving rather than exact. The template has been through
// several versions over the years and nobody kept the old ones: labels may or
// may not carry an emoji, the colon may be followed by anything, sections may
// be missing entirely, and the html version arrives with tags and entities in
// the way. So every field is found by its LABEL anywhere in the text, and a
// missing one is null rather than a parse failure. The only field that
// actually matters is the email address, and there is a fallback for that too.

// One label, as a line-anchored pattern: optional emoji/symbol and whitespace,
// the label, a colon or question mark (as in "Opt In?"), then the value up to
// the end of the line.
const labelRe = (name) => new RegExp(
  String.raw`^[^\S\r\n]*[^\w\r\n]{0,4}[^\S\r\n]*(?:${name})[^\S\r\n]*[:?][^\S\r\n]*(.*)$`,
  'gim',
);

// Names are tried IN ORDER, and a label that turns out to be empty is skipped
// rather than accepted.
//
// Both rules exist because of the section headings. The template writes
// "PROJECT DETAILS:" as a heading immediately above "📋 Description: …", and a
// naive match takes the heading — which has no value — and reports the enquiry
// as having no description while leaving the real one stranded. Longest and
// most specific labels therefore come first, and only a label with something
// after it counts.
const FIELDS = {
  name: ['Full Name', 'Contact Name', 'Name'],
  email: ['Email Address', 'E-mail', 'Email'],
  phone: ['Telephone', 'Phone Number', 'Phone', 'Mobile', 'Tel'],
  company: ['Company Name', 'Company', 'Organisation', 'Organization', 'Business'],
  optIn: ['Opt In', 'Opt-In', 'Marketing', 'Subscribe'],
  description: ['Description', 'Message', 'Project Details', 'Details', 'Project'],
  videoLength: ['Video Length', 'Duration', 'Length'],
  timeline: ['Timeline', 'Timescale', 'Deadline'],
  budget: ['Budget'],
  submitted: ['Submitted At', 'Submitted', 'Date'],
  formSession: ['Form Session', 'Session'],
  files: ['Uploaded Files', 'Attachments', 'Files'],
};

// The first labelled line that actually carries a value. Returns where it was
// found too, so the description can pick up its own continuation lines.
function findField(text, names) {
  for (const name of names) {
    const re = labelRe(name);
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = clean(m[1]);
      if (value) return { value, index: m.index, length: m[0].length };
    }
  }
  return null;
}

// Subjects these notifications have gone out under. Used to decide whether a
// message is one of these at all, so a sweep over a loose search doesn't try to
// parse ordinary mail.
const SUBJECT_RE = /(new\s+)?(quote|contact|enquiry|inquiry)\s*(request|form|enquiry|submission)?/i;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// html → text, keeping the line structure the labels depend on.
export function bodyToText(html) {
  return String(html || '')
    .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

const clean = (v) => {
  const s = String(v ?? '').trim().replace(/^[-–—:]\s*/, '').trim();
  if (!s) return null;
  // The template prints empty fields as the label alone; some versions put a
  // literal "null"/"n/a" there instead.
  if (/^(null|undefined|n\/?a|none|-)$/i.test(s)) return null;
  return s;
};

const truthy = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'checked' || s === 'on';
};

// A date we can trust, or null. The template's own "Submitted" line is an ISO
// timestamp and is the real submission time; the message's own date is the
// fallback (they're seconds apart, but only one of them is what the enquirer
// did).
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // A date far in the future is a mis-parse, not a submission.
  if (d.getTime() > Date.now() + 86400000) return null;
  return d.toISOString();
}

// Returns the enquiry, or null when this message isn't one of these
// notifications. `fallbackAt` is the message's own date.
//
// The bar for "is one of these" is deliberately: it looks like a form
// notification AND it yielded an email address that isn't one of ours. Anything
// less would start inventing enquiries out of ordinary correspondence.
export function parseQuoteRequestEmail({ subject, body, html, fallbackAt = null, internalDomains = [] }) {
  const text = body && body.trim() ? String(body) : bodyToText(html);
  if (!text || !text.trim()) return null;

  const looksRight = SUBJECT_RE.test(String(subject || ''))
    || /CONTACT INFORMATION|PROJECT DETAILS|Opt In/i.test(text);
  if (!looksRight) return null;

  const grab = (names) => findField(text, names)?.value ?? null;

  let email = (grab(FIELDS.email) || '').toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    // "Email: Lauren <lauren@tb.co.uk>" and similar.
    email = (email.match(EMAIL_RE) || [])[0]?.toLowerCase() || null;
  }
  const isOurs = (addr) => internalDomains.some((d) => String(addr).toLowerCase().endsWith('@' + d));
  if (!email) {
    // No labelled address: take the first one in the body that isn't ours. This
    // is what rescues the older template versions.
    const all = (text.match(EMAIL_RE) || []).map((e) => e.toLowerCase());
    email = all.find((e) => !isOurs(e)) || null;
  }
  if (!email || isOurs(email)) return null;

  const submitted = parseDate(grab(FIELDS.submitted)) || parseDate(fallbackAt);

  const descriptionField = findField(text, FIELDS.description);
  const videoLength = grab(FIELDS.videoLength);
  // The description in these emails often runs on past its own line — the rest
  // of the paragraph is part of what they asked for, and dropping it loses the
  // most useful thing in the record.
  const extra = descriptionTail(text, descriptionField);

  return {
    name: grab(FIELDS.name),
    email,
    phone: grab(FIELDS.phone),
    company: grab(FIELDS.company),
    optIn: truthy(grab(FIELDS.optIn)),
    description: [descriptionField?.value, extra].filter(Boolean).join('\n') || null,
    videoLength,
    timeline: grab(FIELDS.timeline),
    budget: grab(FIELDS.budget),
    submittedAt: submitted,
    formSession: grab(FIELDS.formSession),
    files: grab(FIELDS.files),
  };
}

// Everything between the Description line and the next section heading — the
// free-text continuation the template doesn't label.
function descriptionTail(text, field) {
  if (!field) return null;
  const after = text.slice(field.index + field.length);
  const stop = after.search(/\n[^\S\n]*[^\w\r\n]{0,4}[^\S\n]*(TIMELINE|BUDGET|ADDITIONAL|Video Length|Submitted|Form Session|Uploaded Files)/i);
  const tail = (stop === -1 ? after : after.slice(0, stop));
  const cleaned = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[^\w]{0,4}\s*(Video Length|Uploaded Files|Submitted|Form Session)\s*[:?]/i.test(l))
    .join('\n')
    .trim();
  return cleaned || null;
}
