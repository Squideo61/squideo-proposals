// Find people who enquired by email and never made it into the CRM.
//
// The website quote form writes to quote_requests, so those enquirers are
// already on the mailing lists. This is for the other kind: someone who emailed
// asking about a video years ago, before the form existed or instead of using
// it. Their address exists in exactly one place — the mailbox — and the synced
// copy only goes back 30 days (see gmailBackfill), so this searches Gmail
// itself.
//
// ── WHY THIS IS A SEARCH AND A REVIEW, NOT A SCRAPE ─────────────────────────
// Harvesting every address in a mailbox would collect suppliers, freelancers,
// the accountant, competitors, journalists, recruiters, whoever was cc'd on a
// thread once, and a great many robots. Emailing that list is how a marketing
// email becomes a spam complaint, and under PECR the soft opt-in only covers
// an address obtained "in the course of negotiations for a sale" — which is
// what a quote enquiry is, and what a supplier's invoice is not.
//
// So two things are deliberate and should stay that way:
//   1. A QUERY, not the whole mailbox. The caller says what an enquiry looks
//      like; the default presets look for enquiry-shaped mail.
//   2. Nothing is imported automatically. Candidates come back with the
//      evidence — the subject line, the date, how many times they wrote — and
//      a person decides. The evidence is the point: it's what makes "should
//      this address be on a marketing list" a question someone can answer.
//
// Read-only. Uses the gmail.readonly scope the CRM already holds, and writes
// nothing to Gmail.

import sql from '../db.js';
import { getFreshAccessToken } from './gmail.js';
import { INTERNAL_EMAIL_PATTERNS, isInternalEmail } from '../internalAccounts.js';

// Search presets. Offered as a starting point rather than hard-coded, because
// what an enquiry looked like in 2019 is something only the person reading the
// mailbox knows — and Gmail's own search syntax is the best tool for saying it.
export const HARVEST_PRESETS = [
  {
    key: 'quote_subjects',
    label: 'Enquiry-shaped subject lines',
    hint: 'Mail whose subject mentions a quote, enquiry or video project.',
    query: 'subject:(quote OR quotation OR enquiry OR inquiry OR "video project" OR "explainer video") -in:chats',
  },
  {
    key: 'form_notifications',
    label: 'Website form notifications',
    hint: 'The "New quote request" alerts the site sends us — one per form submission, ever.',
    query: 'subject:("New quote request" OR "New enquiry" OR "New contact request" OR "Contact form")',
  },
  {
    key: 'enquiries_inbox',
    label: 'Anything sent to enquiries@',
    hint: 'Everything that landed on the enquiries address, whoever it came from.',
    query: 'to:enquiries@squideo.co.uk -in:chats',
  },
];

// Addresses that are never a person we could email. Robots, ticketing systems
// and the reply-to addresses of other people's marketing.
const ROBOT_PATTERNS = [
  /^no-?reply@/i, /^do-?not-?reply@/i, /^bounce/i, /^mailer-daemon@/i, /^postmaster@/i,
  /^notifications?@/i, /^alerts?@/i, /^news(letter)?@/i, /^marketing@/i, /^support@(google|apple|microsoft|xero|stripe)\./i,
  /@(mail|email|e|em|reply|bounces?|notifications?)\./i,
  /^.*\+.*@(facebook|linkedin|twitter|x)\.com$/i,
];
const ROBOT_DOMAINS = [
  'google.com', 'googlemail.com', 'accounts.google.com', 'linkedin.com', 'facebookmail.com',
  'twitter.com', 'x.com', 'stripe.com', 'xero.com', 'vercel.com', 'github.com', 'slack.com',
  'dropbox.com', 'wetransfer.com', 'calendly.com', 'zoom.us', 'docusign.net', 'mailchimp.com',
  'resend.com', 'sentry.io', 'notion.so', 'canva.com', 'adobe.com', 'godaddy.com', 'duda.co',
];

function isRobotAddress(email) {
  const e = String(email || '').toLowerCase();
  if (!e.includes('@')) return true;
  if (ROBOT_PATTERNS.some((re) => re.test(e))) return true;
  const domain = e.split('@')[1] || '';
  return ROBOT_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

// "Sam Taylor <sam@acme.com>" → { name, email }.
function parseAddress(raw) {
  const s = String(raw || '').trim();
  const angled = s.match(/^(.*)<([^>]+)>\s*$/);
  const email = (angled ? angled[2] : s).trim().toLowerCase();
  let name = angled ? angled[1].trim().replace(/^["']|["']$/g, '') : '';
  if (name.toLowerCase() === email) name = '';
  return { name: name || null, email };
}

const headerOf = (msg, key) => (msg.payload?.headers || [])
  .find((h) => h.name.toLowerCase() === key)?.value || '';

// Chunked parallel fetch. Gmail's per-user rate limit is generous but not
// infinite, and 25 at a time keeps us well inside it while still clearing a few
// hundred messages inside one request.
const FETCH_CONCURRENCY = 25;
async function fetchMetadata(ids, accessToken) {
  const out = [];
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const slice = ids.slice(i, i + FETCH_CONCURRENCY);
    const got = await Promise.all(slice.map(async (id) => {
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
      url.searchParams.set('format', 'metadata');
      ['From', 'To', 'Cc', 'Subject', 'Date'].forEach((h) => url.searchParams.append('metadataHeaders', h));
      const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
      if (!res.ok) return null;
      return res.json();
    }));
    out.push(...got.filter(Boolean));
  }
  return out;
}

// Time budget for one call. Vercel allows 60s; stopping at 40 leaves room to
// score and return what we already have, so a big mailbox returns a partial
// result with a page token instead of a timeout.
const BUDGET_MS = 40000;
const MAX_MESSAGES = 500;

export async function harvestCandidates({ userEmail, query, pageToken = null, maxMessages = MAX_MESSAGES }) {
  const accessToken = await getFreshAccessToken(userEmail);
  const startedAt = Date.now();

  const messageIds = [];
  let nextPageToken = pageToken;
  let searched = 0;
  do {
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('q', query);
    listUrl.searchParams.set('maxResults', '100');
    if (nextPageToken) listUrl.searchParams.set('pageToken', nextPageToken);
    const res = await fetch(listUrl.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Gmail search failed (${res.status})`);
      err.detail = body.slice(0, 300);
      throw err;
    }
    const json = await res.json();
    (json.messages || []).forEach((m) => messageIds.push(m.id));
    nextPageToken = json.nextPageToken || null;
    searched = messageIds.length;
  } while (nextPageToken && searched < maxMessages && Date.now() - startedAt < BUDGET_MS / 2);

  const messages = await fetchMetadata(messageIds.slice(0, maxMessages), accessToken);

  // Fold the messages down to one entry per address. Only the SENDER of inbound
  // mail counts: someone who wrote to us started a conversation, where a person
  // cc'd on a thread did not, and the difference matters when the output is a
  // marketing list.
  const me = String(userEmail || '').toLowerCase();
  const found = new Map();
  for (const msg of messages) {
    const from = parseAddress(headerOf(msg, 'from'));
    if (!from.email || from.email === me) continue;              // our own sent mail
    if (isInternalEmail(from.email)) continue;                   // the rest of the team
    if (isRobotAddress(from.email)) continue;                    // robots and platforms
    const subject = headerOf(msg, 'subject') || '(no subject)';
    const dateHeader = headerOf(msg, 'date');
    const at = dateHeader ? new Date(dateHeader) : new Date(Number(msg.internalDate || Date.now()));
    const when = Number.isNaN(at.getTime()) ? new Date(Number(msg.internalDate || Date.now())) : at;

    const existing = found.get(from.email);
    if (existing) {
      existing.messages += 1;
      if (from.name && !existing.name) existing.name = from.name;
      if (when > new Date(existing.lastAt)) {
        existing.lastAt = when.toISOString();
        existing.lastSubject = subject;
      }
      if (when < new Date(existing.firstAt)) existing.firstAt = when.toISOString();
    } else {
      found.set(from.email, {
        email: from.email,
        name: from.name,
        messages: 1,
        firstAt: when.toISOString(),
        lastAt: when.toISOString(),
        lastSubject: subject,
        threadId: msg.threadId || null,
      });
    }
  }

  const emails = [...found.keys()];
  const known = emails.length ? await classifyKnown(emails) : new Map();

  const candidates = [...found.values()].map((c) => ({
    ...c,
    // What the CRM already knows about them, so nobody re-imports half their
    // contacts book or is offered somebody who has unsubscribed.
    known: known.get(c.email) || 'new',
  })).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  return {
    query,
    searched: messages.length,
    listed: messageIds.length,
    nextPageToken: nextPageToken && messageIds.length >= maxMessages ? nextPageToken : null,
    candidates,
    counts: {
      total: candidates.length,
      new: candidates.filter((c) => c.known === 'new').length,
      onList: candidates.filter((c) => c.known === 'on_list').length,
      unsubscribed: candidates.filter((c) => c.known === 'unsubscribed').length,
    },
  };
}

// One query per source, not one per address — a mailbox sweep can easily turn
// up a few hundred people.
async function classifyKnown(emails) {
  const map = new Map();
  const [contacts, signups, quotes, suppressed] = await Promise.all([
    sql`SELECT LOWER(TRIM(email)) AS email, provisional FROM contacts WHERE LOWER(TRIM(email)) = ANY(${emails})`.catch(() => []),
    sql`SELECT LOWER(TRIM(email)) AS email FROM course_signups WHERE LOWER(TRIM(email)) = ANY(${emails})`.catch(() => []),
    sql`SELECT LOWER(TRIM(email)) AS email FROM quote_requests WHERE LOWER(TRIM(email)) = ANY(${emails})`.catch(() => []),
    sql`SELECT email FROM email_suppressions WHERE email = ANY(${emails})`.catch(() => []),
  ]);
  // Weakest claim first, strongest last — a suppression beats everything.
  contacts.forEach((r) => map.set(r.email, r.provisional ? 'provisional' : 'on_list'));
  signups.forEach((r) => map.set(r.email, 'on_list'));
  quotes.forEach((r) => map.set(r.email, 'on_list'));
  suppressed.forEach((r) => map.set(r.email, 'unsubscribed'));
  return map;
}

// Import the ticked addresses as ordinary CRM contacts, so they appear on the
// contacts page as well as the mailing lists — an address that only exists
// inside a marketing tool is one nobody will ever maintain.
//
// Suppressed addresses are refused outright rather than filtered quietly: being
// asked to re-add someone who unsubscribed is worth an answer, not a silence.
export async function importCandidates({ people, importedBy }) {
  const results = { added: 0, updated: 0, skipped: [] };
  for (const p of people || []) {
    const email = String(p.email || '').trim().toLowerCase();
    if (!email.includes('@')) { results.skipped.push({ email, why: 'Not an email address' }); continue; }
    if (isInternalEmail(email)) { results.skipped.push({ email, why: 'One of ours' }); continue; }

    const [supp] = await sql`SELECT email FROM email_suppressions WHERE email = ${email}`.catch(() => []);
    if (supp) { results.skipped.push({ email, why: 'They have unsubscribed' }); continue; }

    const [existing] = await sql`
      SELECT id, provisional FROM contacts WHERE LOWER(TRIM(email)) = ${email} LIMIT 1`;
    // A provisional contact is one email sync guessed at. Being able to point
    // at the enquiry they sent us is exactly the evidence that makes it a real
    // one, so promote rather than duplicate.
    if (existing) {
      if (existing.provisional) {
        await sql`
          UPDATE contacts
             SET provisional = FALSE,
                 source = COALESCE(source, 'gmail_enquiry'),
                 name = COALESCE(NULLIF(TRIM(COALESCE(name, '')), ''), ${p.name || null}),
                 updated_at = NOW()
           WHERE id = ${existing.id}`;
        results.updated += 1;
      } else {
        results.skipped.push({ email, why: 'Already a contact' });
      }
      continue;
    }

    const id = 'ct_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    // The note is the audit trail: months from now, "why is this person on our
    // marketing list" has an answer written next to them.
    const note = [
      'Added from Gmail — they emailed us.',
      p.lastSubject ? `Last subject: “${p.lastSubject}”` : null,
      p.lastAt ? `Last message: ${new Date(p.lastAt).toISOString().slice(0, 10)}` : null,
      p.messages ? `${p.messages} message${p.messages === 1 ? '' : 's'} from this address` : null,
      importedBy ? `Imported by ${importedBy}` : null,
    ].filter(Boolean).join('\n');
    await sql`
      INSERT INTO contacts (id, email, name, notes, provisional, source)
      VALUES (${id}, ${email}, ${p.name || null}, ${note}, FALSE, 'gmail_enquiry')`;
    results.added += 1;
  }
  return results;
}
