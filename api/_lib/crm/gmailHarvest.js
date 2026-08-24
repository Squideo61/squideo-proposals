// Find people who enquired by email and never made it into the CRM — across
// the WHOLE mailbox, including years that predate the CRM.
//
// The website quote form writes to quote_requests, so those enquirers are
// already on the mailing lists. This is for the other kind: someone who emailed
// asking about a video in 2019, before the form existed or instead of using it.
// Their address exists in exactly one place — the mailbox — and the synced copy
// only goes back 30 days (see gmailBackfill), so this searches Gmail itself.
//
// ── WHY THIS IS A JOB, NOT A REQUEST ────────────────────────────────────────
// A ten-year mailbox is tens of thousands of messages and cannot be read inside
// one HTTP request. So a sweep is a durable run: the matching message ids are
// listed once and stored, then a cron works through them a batch at a time. The
// tab can be closed; a failed invocation retries; progress is a row in the
// database rather than something held in a browser.
//
// ── WHY IT IS A SEARCH AND A REVIEW, NOT A SCRAPE ───────────────────────────
// Harvesting every address in a mailbox would collect suppliers, freelancers,
// the accountant, competitors, journalists, recruiters, whoever was cc'd on a
// thread once, and a great many robots. Emailing that list is how a marketing
// email becomes a spam complaint, and under PECR the soft opt-in only covers an
// address obtained "in the course of negotiations for a sale" — which is what a
// quote enquiry is, and what a supplier's invoice is not.
//
// So two things are deliberate and should stay that way:
//   1. A QUERY, not the whole mailbox. The caller says what an enquiry looks
//      like; the presets below are a starting point.
//   2. Nothing joins a mailing list automatically. People come back with the
//      evidence — the subject line they wrote, when, how often — and somebody
//      decides. `ingest` files the MESSAGES into the CRM's email views, which
//      is a different act from putting an address on a marketing list.

import sql, { batchWrite } from '../db.js';
import { getFreshAccessToken } from './gmail.js';
import { isInternalEmail, INTERNAL_EMAIL_PATTERNS } from '../internalAccounts.js';
import { ingestMessage, extractBody, parseHeaders } from '../gmailSync.js';
import { makeId } from './shared.js';
import { parseQuoteRequestEmail } from './quoteEmailParser.js';

// Our own domains, in the shape the parser wants them: it has to know which
// address in a notification body is ours so it doesn't record us as the person
// who enquired.
const OUR_DOMAINS = INTERNAL_EMAIL_PATTERNS.map((p) => p.replace(/^%@/, ''));

// What a sweep is looking for.
//
//   'people'      — the SENDER of inbound mail: someone who wrote to us.
//   'quote_forms' — the website's own "New Quote Request" notifications, where
//                   the sender is US and the enquirer is in the body. These are
//                   the only surviving record of years of enquiries from before
//                   the CRM, and they parse into complete quote requests —
//                   name, email, phone, company, brief, budget, timeline and
//                   the marketing tick — not just an address.
export const HARVEST_MODES = ['people', 'quote_forms'];

// Search presets. A starting point rather than a rule, because what an enquiry
// looked like in 2019 is something only the person reading the mailbox knows —
// and Gmail's own search syntax is the best tool for saying it.
//
// None of these carry a date limit: a sweep goes back as far as the mailbox
// does. Add `before:`/`after:` yourself to narrow it.
export const HARVEST_PRESETS = [
  {
    key: 'quote_form_emails',
    mode: 'quote_forms',
    label: 'Old website quote requests',
    hint: 'The "New Quote Request" emails the site has sent us since forever. '
      + 'Every one of these becomes a proper quote request in the CRM, with the '
      + "enquirer's name, phone, company, brief and budget read out of the email.",
    query: 'subject:("Quote Request" OR "New Quote Request" OR "New Enquiry" OR "Contact Form")',
  },
  {
    key: 'quote_subjects',
    mode: 'people',
    label: 'Enquiry-shaped subject lines',
    hint: 'Mail whose subject mentions a quote, enquiry or video project.',
    query: 'subject:(quote OR quotation OR enquiry OR inquiry OR "video project" OR "explainer video") -in:chats',
  },
  {
    key: 'form_notifications',
    mode: 'people',
    label: 'Website form notifications',
    hint: 'The "New quote request" alerts the site sends us — one per form submission, ever.',
    query: 'subject:("New quote request" OR "New enquiry" OR "New contact request" OR "Contact form")',
  },
  {
    key: 'enquiries_inbox',
    mode: 'people',
    label: 'Anything sent to enquiries@',
    hint: 'Everything that landed on the enquiries address, whoever it came from.',
    query: 'to:enquiries@squideo.co.uk -in:chats',
  },
  {
    key: 'everything_inbound',
    mode: 'people',
    label: 'Every message anyone sent us',
    hint: 'The whole inbox, ever. Expect suppliers and robots in the results — read the evidence column before ticking.',
    query: 'in:inbox -in:chats',
  },
];

// Addresses that are never a person we could email. Robots, ticketing systems
// and the reply-to addresses of other people's marketing.
const ROBOT_PATTERNS = [
  /^no-?reply@/i, /^do-?not-?reply@/i, /^bounce/i, /^mailer-daemon@/i, /^postmaster@/i,
  /^notifications?@/i, /^alerts?@/i, /^news(letter)?@/i, /^marketing@/i,
  /^support@(google|apple|microsoft|xero|stripe)\./i,
  /@(mail|email|e|em|reply|bounces?|notifications?)\./i,
  /^.*\+.*@(facebook|linkedin|twitter|x)\.com$/i,
];
const ROBOT_DOMAINS = [
  'google.com', 'googlemail.com', 'accounts.google.com', 'linkedin.com', 'facebookmail.com',
  'twitter.com', 'x.com', 'stripe.com', 'xero.com', 'vercel.com', 'github.com', 'slack.com',
  'dropbox.com', 'wetransfer.com', 'calendly.com', 'zoom.us', 'docusign.net', 'mailchimp.com',
  'resend.com', 'sentry.io', 'notion.so', 'canva.com', 'adobe.com', 'godaddy.com', 'duda.co',
];

export function isRobotAddress(email) {
  const e = String(email || '').toLowerCase();
  if (!e.includes('@')) return true;
  if (ROBOT_PATTERNS.some((re) => re.test(e))) return true;
  const domain = e.split('@')[1] || '';
  return ROBOT_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

// "Sam Taylor <sam@acme.com>" → { name, email }.
export function parseAddress(raw) {
  const s = String(raw || '').trim();
  const angled = s.match(/^(.*)<([^>]+)>\s*$/);
  const email = (angled ? angled[2] : s).trim().toLowerCase();
  let name = angled ? angled[1].trim().replace(/^["']|["']$/g, '') : '';
  if (name.toLowerCase() === email) name = '';
  return { name: name || null, email };
}

const headerOf = (msg, key) => (msg.payload?.headers || [])
  .find((h) => h.name.toLowerCase() === key)?.value || '';

// ── schema self-heal ────────────────────────────────────────────────────────
// Migrations are applied by hand in Neon. Must not reject.
let harvestTablesReady = null;
export function ensureHarvestTables() {
  if (harvestTablesReady) return harvestTablesReady;
  harvestTablesReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS email_harvest_runs (
        id            TEXT        PRIMARY KEY,
        user_email    TEXT        NOT NULL,
        query         TEXT        NOT NULL,
        ingest        BOOLEAN     NOT NULL DEFAULT FALSE,
        status        TEXT        NOT NULL DEFAULT 'listing',
        page_token    TEXT,
        listed        INTEGER     NOT NULL DEFAULT 0,
        processed     INTEGER     NOT NULL DEFAULT 0,
        ingested      INTEGER     NOT NULL DEFAULT 0,
        failed        INTEGER     NOT NULL DEFAULT 0,
        error         TEXT,
        started_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at  TIMESTAMPTZ
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS email_harvest_messages (
        run_id           TEXT NOT NULL REFERENCES email_harvest_runs(id) ON DELETE CASCADE,
        gmail_message_id TEXT NOT NULL,
        state            TEXT NOT NULL DEFAULT 'queued',
        PRIMARY KEY (run_id, gmail_message_id)
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS email_harvest_people (
        run_id       TEXT NOT NULL REFERENCES email_harvest_runs(id) ON DELETE CASCADE,
        email        TEXT NOT NULL,
        name         TEXT,
        messages     INTEGER NOT NULL DEFAULT 0,
        first_at     TIMESTAMPTZ,
        last_at      TIMESTAMPTZ,
        last_subject TEXT,
        thread_id    TEXT,
        imported_at  TIMESTAMPTZ,
        PRIMARY KEY (run_id, email)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS email_harvest_messages_state_idx
                ON email_harvest_messages (run_id, state)`;
    await sql`CREATE INDEX IF NOT EXISTS email_harvest_people_last_idx
                ON email_harvest_people (run_id, last_at DESC)`;
    await sql`ALTER TABLE email_harvest_runs
                ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'people'`;
    await sql`ALTER TABLE email_harvest_runs
                ADD COLUMN IF NOT EXISTS imported INTEGER NOT NULL DEFAULT 0`;
    // The idempotency key for recovered enquiries — re-running a sweep must not
    // create a second copy of the same quote request.
    await sql`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS source_message_id TEXT`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS quote_requests_source_message_idx
                ON quote_requests(source_message_id) WHERE source_message_id IS NOT NULL`;
    return true;
  })().catch((err) => {
    console.warn('[harvest] ensure failed', err.message);
    harvestTablesReady = null;
    return false;
  });
  return harvestTablesReady;
}

// ── budgets ─────────────────────────────────────────────────────────────────
// Gmail allows 500 ids per list call, so even a 20,000-message mailbox lists in
// 40 calls. Reading each message is the expensive half, which is why listing
// happens up front and reading is what gets spread across cron runs.
const LIST_PAGE = 500;
const LIST_PAGES_PER_CALL = 40;
// Metadata reads are cheap; a full ingest also writes half a dozen rows per
// message, so it runs narrower.
const READ_BATCH = 150;
const READ_CONCURRENCY = 20;
const INGEST_BATCH = 90;
const INGEST_CONCURRENCY = 12;

// ── starting a sweep ────────────────────────────────────────────────────────
export async function startHarvestRun({ userEmail, query, ingest = false, mode = 'people', startedBy }) {
  await ensureHarvestTables();
  // One active run at a time. Two sweeps of the same mailbox would just race
  // each other for the same Gmail quota.
  const [active] = await sql`
    SELECT id FROM email_harvest_runs
     WHERE user_email = ${userEmail} AND status IN ('listing', 'working')
     LIMIT 1`;
  if (active) {
    const err = new Error('A sweep is already running');
    err.code = 'ALREADY_RUNNING';
    err.runId = active.id;
    throw err;
  }
  const id = makeId('hrv');
  await sql`
    INSERT INTO email_harvest_runs (id, user_email, query, ingest, mode, status, started_by)
    VALUES (${id}, ${userEmail}, ${query}, ${!!ingest},
            ${HARVEST_MODES.includes(mode) ? mode : 'people'}, 'listing', ${startedBy || userEmail})`;
  return id;
}

export async function cancelHarvestRun(runId) {
  await sql`
    UPDATE email_harvest_runs
       SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
     WHERE id = ${runId} AND status IN ('listing', 'working')`;
}

// ── the worker ──────────────────────────────────────────────────────────────
// Advances one run for up to `budgetMs`. Called by the cron every minute and
// once inline when a sweep starts, so the first results appear immediately
// rather than up to a minute later. Returns the run row as it now stands.
export async function sweepHarvestRun({ runId = null, budgetMs = 40000 } = {}) {
  const ready = await ensureHarvestTables();
  if (!ready) return { ok: false, error: 'Harvest tables unavailable' };

  const [run] = runId
    ? await sql`SELECT * FROM email_harvest_runs WHERE id = ${runId}`
    : await sql`SELECT * FROM email_harvest_runs WHERE status IN ('listing', 'working')
                 ORDER BY created_at ASC LIMIT 1`;
  if (!run || !['listing', 'working'].includes(run.status)) return { ok: true, idle: true };

  const startedAt = Date.now();
  let accessToken;
  try {
    accessToken = await getFreshAccessToken(run.user_email);
  } catch (err) {
    await failRun(run.id, err.code === 'NOT_CONNECTED'
      ? 'Gmail is no longer connected for this account'
      : (err.message || 'Could not reach Gmail'));
    return { ok: false, error: err.message };
  }

  try {
    if (run.status === 'listing') {
      await listPage({ run, accessToken, startedAt, budgetMs });
    } else {
      await readBatch({ run, accessToken, startedAt, budgetMs });
    }
  } catch (err) {
    // A transient Gmail error shouldn't kill a sweep that is 80% done — the
    // next cron run picks up exactly where this one stopped.
    console.error('[harvest] sweep step failed', { run: run.id, err: err.message });
    await sql`UPDATE email_harvest_runs SET error = ${err.message?.slice(0, 300) || 'failed'}, updated_at = NOW()
               WHERE id = ${run.id}`;
  }

  const [after] = await sql`SELECT * FROM email_harvest_runs WHERE id = ${run.id}`;
  return { ok: true, run: serialiseRun(after) };
}

// Tell whoever started it. A full-mailbox sweep runs for minutes in the
// background — the whole point of making it a durable job was that you could
// walk away, which only works if something tells you when to come back.
//
// Best-effort: a sweep that finished successfully must not be reported as
// failed because a bell didn't ring.
async function notifyFinished(run) {
  try {
    const { sendNotification, ensureHarvestNotificationDefault } = await import('../notifications.js');
    // Without a role default this key resolves to "off" and the alert would
    // never be sent — which looks exactly like a sweep that hung.
    await ensureHarvestNotificationDefault();
    const [{ n: people }] = await sql`
      SELECT COUNT(*)::int AS n FROM email_harvest_people WHERE run_id = ${run.id}`;
    const quoteMode = run.mode === 'quote_forms';
    const headline = quoteMode
      ? `${(run.imported || 0).toLocaleString('en-GB')} old quote requests recovered`
      : `${people.toLocaleString('en-GB')} ${people === 1 ? 'person' : 'people'} found in your mailbox`;
    const detail = [
      `Read ${(run.processed || 0).toLocaleString('en-GB')} messages.`,
      quoteMode
        ? 'They\'re in Quote Requests (filter: all) and on your mailing lists.'
        : 'Open Marketing → Email to review who to add.',
      run.failed ? `${run.failed} could not be read.` : null,
    ].filter(Boolean).join(' ');

    await sendNotification('marketing.harvest_done', {
      ownerEmail: run.started_by,
      inAppOnly: true,
      subject: `Gmail sweep finished — ${headline}`,
      inApp: {
        title: `Gmail sweep finished — ${headline}`,
        body: detail,
        link: '#/marketing/email',
        tag: `harvest-${run.id}`,
      },
    });
  } catch (err) {
    console.warn('[harvest] finish notification failed', err.message);
  }
}

async function failRun(id, message) {
  await sql`
    UPDATE email_harvest_runs
       SET status = 'failed', error = ${message}, completed_at = NOW(), updated_at = NOW()
     WHERE id = ${id}`;
}

// Phase one: enumerate every matching message id. Cheap (ids only) and done
// before any reading, so the run knows its own size and the progress bar means
// something from the first tick.
async function listPage({ run, accessToken, startedAt, budgetMs }) {
  let pageToken = run.page_token || null;
  let pages = 0;
  let added = 0;

  while (pages < LIST_PAGES_PER_CALL && Date.now() - startedAt < budgetMs) {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', run.query);
    url.searchParams.set('maxResults', String(LIST_PAGE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gmail search failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const ids = (json.messages || []).map((m) => m.id);
    if (ids.length) {
      await batchWrite(ids.map((id) => sql`
        INSERT INTO email_harvest_messages (run_id, gmail_message_id)
        VALUES (${run.id}, ${id})
        ON CONFLICT (run_id, gmail_message_id) DO NOTHING`));
      added += ids.length;
    }
    pageToken = json.nextPageToken || null;
    pages += 1;
    if (!pageToken) break;
  }

  const done = !pageToken;
  await sql`
    UPDATE email_harvest_runs
       SET page_token = ${pageToken},
           listed = listed + ${added},
           status = ${done ? 'working' : 'listing'},
           updated_at = NOW()
     WHERE id = ${run.id}`;
}

// Phase two: read the messages. Claimed in one statement so two overlapping
// cron runs can never read — or ingest — the same message twice.
async function readBatch({ run, accessToken, startedAt, budgetMs }) {
  const quoteForms = run.mode === 'quote_forms';
  // Parsing needs the whole message, not just its headers, so it runs at the
  // narrower ingest width even when it isn't filing anything.
  const heavy = run.ingest || quoteForms;
  const size = heavy ? INGEST_BATCH : READ_BATCH;
  const concurrency = heavy ? INGEST_CONCURRENCY : READ_CONCURRENCY;

  while (Date.now() - startedAt < budgetMs) {
    const claimed = await sql`
      UPDATE email_harvest_messages m
         SET state = 'working'
        FROM (
          SELECT gmail_message_id FROM email_harvest_messages
           WHERE run_id = ${run.id} AND state = 'queued'
           LIMIT ${size}
           FOR UPDATE SKIP LOCKED
        ) c
       WHERE m.run_id = ${run.id} AND m.gmail_message_id = c.gmail_message_id
      RETURNING m.gmail_message_id`;
    if (!claimed.length) {
      // Nothing queued: finished, unless something is still mid-flight from a
      // run that died — those are left 'working' and swept up by requeueStale.
      const [{ n }] = await sql`
        SELECT COUNT(*)::int AS n FROM email_harvest_messages
         WHERE run_id = ${run.id} AND state = 'working'`;
      if (!n) {
        // Claim the completion in the same statement that records it, so the
        // "finished" notification fires exactly once however many cron runs
        // arrive at an empty queue together.
        const finished = await sql`
          UPDATE email_harvest_runs
             SET status = 'done', completed_at = NOW(), updated_at = NOW()
           WHERE id = ${run.id} AND status = 'working'
          RETURNING id, mode, processed, imported, ingested, failed, started_by, query`;
        if (finished.length) await notifyFinished(finished[0]);
      }
      return;
    }

    const ids = claimed.map((r) => r.gmail_message_id);
    const found = [];
    const enquiries = [];
    let ingested = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i += concurrency) {
      const slice = ids.slice(i, i + concurrency);
      const results = await Promise.all(slice.map(async (id) => {
        try {
          if (run.ingest) {
            // Files the message into the CRM's own email tables — the same
            // path live mail takes, so these threads look and behave exactly
            // like any other, auto-linking to a deal where one matches.
            await ingestMessage({ userEmail: run.user_email, accessToken, messageId: id });
          }
          if (quoteForms) {
            const enquiry = await readQuoteForm(id, accessToken);
            return { id, enquiry, ok: true };
          }
          const meta = await fetchMetadata(id, accessToken);
          return { id, meta, ok: true };
        } catch (err) {
          console.warn('[harvest] message failed', id, err.message);
          return { id, ok: false };
        }
      }));
      results.forEach((r) => {
        if (!r.ok) { failed += 1; return; }
        if (run.ingest) ingested += 1;
        if (r.meta) found.push(r.meta);
        if (r.enquiry) enquiries.push(r.enquiry);
      });
    }

    let imported = 0;
    if (quoteForms) {
      imported = await saveEnquiries(run, enquiries);
      // Show them in the run's own results too, so the screen lists what it
      // pulled in rather than just counting it.
      await foldPeople(run, enquiries.map((e) => ({
        email: e.email,
        name: e.name,
        subject: e.description ? e.description.slice(0, 120) : 'Quote request',
        at: e.submittedAt,
        threadId: e.threadId,
      })), { imported: true });
    } else {
      await foldPeople(run, found);
    }

    await batchWrite(ids.map((id) => sql`
      UPDATE email_harvest_messages SET state = 'done'
       WHERE run_id = ${run.id} AND gmail_message_id = ${id}`));
    await sql`
      UPDATE email_harvest_runs
         SET processed = processed + ${ids.length},
             ingested = ingested + ${ingested},
             imported = imported + ${imported},
             failed = failed + ${failed},
             updated_at = NOW()
       WHERE id = ${run.id}`;
  }
}

// Read one website notification email and pull the enquiry back out of its
// body. Needs the full message — the whole point is that the headers describe
// us, not the person who filled the form in.
async function readQuoteForm(id, accessToken) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
  url.searchParams.set('format', 'full');
  const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!res.ok) return null;
  const msg = await res.json();
  const headers = parseHeaders(msg.payload?.headers || []);
  const { html, text } = extractBody(msg.payload);
  const sentAt = headers.date
    ? new Date(headers.date)
    : new Date(Number(msg.internalDate || Date.now()));

  const parsed = parseQuoteRequestEmail({
    subject: headers.subject,
    body: text,
    html,
    fallbackAt: Number.isNaN(sentAt.getTime()) ? null : sentAt.toISOString(),
    internalDomains: OUR_DOMAINS,
  });
  if (!parsed) return null;
  return { ...parsed, messageId: id, threadId: msg.threadId || null };
}

// Write the recovered enquiries into quote_requests — the same table the live
// website form writes to. That is what makes them real: they show up in the
// Quote Requests view, count in Marketing's lead reporting, and land on the
// mailing lists, all through machinery that already exists.
//
// status='cleared' rather than 'new': these are historic, most were dealt with
// years ago, and dropping several hundred of them into the "new" inbox would
// bury the enquiries that actually need answering today. Cleared still counts
// as a lead — it just isn't waiting on anyone.
//
// The unique index on source_message_id is the idempotency: run the sweep twice
// and the second pass writes nothing.
async function saveEnquiries(run, enquiries) {
  const usable = enquiries.filter((e) => e && e.email && !isInternalEmail(e.email));
  if (!usable.length) return 0;

  // Within one batch the same address can appear twice (someone who enquired
  // more than once); each is its own request, keyed by its own message.
  const rows = await Promise.all(usable.map(async (e) => {
    try {
      const inserted = await sql`
        INSERT INTO quote_requests (
          id, name, email, phone, company, project_details, timeline, budget,
          opt_in, status, reviewed_at, source, form_source, source_message_id, created_at
        ) VALUES (
          ${makeId('qr')}, ${e.name}, ${e.email}, ${e.phone}, ${e.company},
          ${[e.description, e.videoLength ? `Video length: ${e.videoLength}` : null]
            .filter(Boolean).join('\n\n') || null},
          ${e.timeline}, ${e.budget}, ${!!e.optIn}, 'cleared', NOW(),
          'web', 'email-import', ${e.messageId},
          ${e.submittedAt || new Date().toISOString()}
        )
        -- The predicate has to be repeated: the unique index is PARTIAL
        -- (source_message_id IS NOT NULL, so the millions of rows without one
        -- don't collide), and Postgres will not infer a partial index without
        -- being shown its condition.
        ON CONFLICT (source_message_id) WHERE source_message_id IS NOT NULL
        DO NOTHING
        RETURNING id`;
      return inserted.length ? 1 : 0;
    } catch (err) {
      console.warn('[harvest] could not save enquiry', e.email, err.message);
      return 0;
    }
  }));
  return rows.reduce((a, b) => a + b, 0);
}

async function fetchMetadata(id, accessToken) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
  url.searchParams.set('format', 'metadata');
  ['From', 'Subject', 'Date'].forEach((h) => url.searchParams.append('metadataHeaders', h));
  const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!res.ok) return null;
  const msg = await res.json();
  const from = parseAddress(headerOf(msg, 'from'));
  if (!from.email) return null;
  const dateHeader = headerOf(msg, 'date');
  const parsed = dateHeader ? new Date(dateHeader) : null;
  const at = parsed && !Number.isNaN(parsed.getTime())
    ? parsed
    : new Date(Number(msg.internalDate || Date.now()));
  return {
    email: from.email,
    name: from.name,
    subject: headerOf(msg, 'subject') || '(no subject)',
    at: at.toISOString(),
    threadId: msg.threadId || null,
  };
}

// Fold this batch's messages into one row per person.
//
// Only the SENDER of inbound mail counts. Someone who wrote to us started a
// conversation; a person cc'd on a thread did not, and the difference matters
// when the output is a marketing list.
async function foldPeople(run, metas, { imported = false } = {}) {
  const me = String(run.user_email || '').toLowerCase();
  const wanted = metas.filter((m) => m
    && m.email
    && m.email !== me
    && !isInternalEmail(m.email)
    // A parsed form enquiry is a person who typed their address into our own
    // form, so the robot filter — which exists to catch senders — doesn't
    // apply to it.
    && (imported || !isRobotAddress(m.email)));
  if (!wanted.length) return;

  // Aggregate within the batch first, so one person in a batch is one write.
  const byEmail = new Map();
  for (const m of wanted) {
    const cur = byEmail.get(m.email);
    if (!cur) { byEmail.set(m.email, { ...m, messages: 1, firstAt: m.at, lastAt: m.at }); continue; }
    cur.messages += 1;
    if (!cur.name && m.name) cur.name = m.name;
    if (m.at > cur.lastAt) { cur.lastAt = m.at; cur.subject = m.subject; cur.threadId = m.threadId; }
    if (m.at < cur.firstAt) cur.firstAt = m.at;
  }

  await batchWrite([...byEmail.values()].map((p) => sql`
    INSERT INTO email_harvest_people
      (run_id, email, name, messages, first_at, last_at, last_subject, thread_id, imported_at)
    VALUES (${run.id}, ${p.email}, ${p.name}, ${p.messages}, ${p.firstAt}, ${p.lastAt},
            ${p.subject}, ${p.threadId}, ${imported ? new Date().toISOString() : null})
    ON CONFLICT (run_id, email) DO UPDATE SET
      messages = email_harvest_people.messages + EXCLUDED.messages,
      name = COALESCE(email_harvest_people.name, EXCLUDED.name),
      first_at = LEAST(email_harvest_people.first_at, EXCLUDED.first_at),
      -- Keep the subject of whichever message is genuinely the most recent, so
      -- the evidence column doesn't jump about as batches land out of order.
      last_subject = CASE WHEN EXCLUDED.last_at >= email_harvest_people.last_at
                          THEN EXCLUDED.last_subject ELSE email_harvest_people.last_subject END,
      thread_id = CASE WHEN EXCLUDED.last_at >= email_harvest_people.last_at
                       THEN EXCLUDED.thread_id ELSE email_harvest_people.thread_id END,
      last_at = GREATEST(email_harvest_people.last_at, EXCLUDED.last_at),
      imported_at = COALESCE(email_harvest_people.imported_at, EXCLUDED.imported_at)`));
}

// Messages left 'working' by an invocation that died go back on the queue.
// Called by the cron before it sweeps, so a crash costs one batch, not a run.
export async function requeueStaleHarvestWork() {
  await ensureHarvestTables();
  await sql`
    UPDATE email_harvest_messages m
       SET state = 'queued'
      FROM email_harvest_runs r
     WHERE r.id = m.run_id
       AND m.state = 'working'
       AND r.status = 'working'
       AND r.updated_at < NOW() - interval '5 minutes'`.catch(() => {});
}

function serialiseRun(row) {
  if (!row) return null;
  const listed = row.listed || 0;
  const processed = row.processed || 0;
  return {
    id: row.id,
    query: row.query,
    ingest: !!row.ingest,
    mode: row.mode || 'people',
    status: row.status,
    listed,
    processed,
    ingested: row.ingested || 0,
    imported: row.imported || 0,
    failed: row.failed || 0,
    error: row.error || null,
    startedBy: row.started_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    // Listing has no total to measure against, so the bar only appears once
    // the sweep knows how big it is.
    percent: row.status === 'listing' ? null
      : (listed > 0 ? Math.min(100, Math.round((processed / listed) * 100)) : 100),
  };
}

// ── reading a run ───────────────────────────────────────────────────────────
export async function latestHarvestRun(userEmail) {
  await ensureHarvestTables();
  const [row] = await sql`
    SELECT * FROM email_harvest_runs
     WHERE user_email = ${userEmail}
     ORDER BY created_at DESC LIMIT 1`;
  return serialiseRun(row);
}

export async function harvestPeople(runId, { limit = 500 } = {}) {
  await ensureHarvestTables();
  const rows = await sql`
    SELECT email, name, messages, first_at, last_at, last_subject, thread_id, imported_at
      FROM email_harvest_people
     WHERE run_id = ${runId}
     ORDER BY last_at DESC
     LIMIT ${Math.min(Number(limit) || 500, 2000)}`;
  const emails = rows.map((r) => r.email);
  const known = emails.length ? await classifyKnown(emails) : new Map();
  const people = rows.map((r) => ({
    email: r.email,
    name: r.name || null,
    messages: r.messages || 0,
    firstAt: r.first_at,
    lastAt: r.last_at,
    lastSubject: r.last_subject || '(no subject)',
    threadId: r.thread_id || null,
    importedAt: r.imported_at || null,
    known: r.imported_at ? 'on_list' : (known.get(r.email) || 'new'),
  }));
  const [totals] = await sql`
    SELECT COUNT(*)::int AS total FROM email_harvest_people WHERE run_id = ${runId}`;
  return {
    people,
    total: totals?.total || 0,
    counts: {
      total: people.length,
      new: people.filter((p) => p.known === 'new').length,
      onList: people.filter((p) => p.known === 'on_list').length,
      unsubscribed: people.filter((p) => p.known === 'unsubscribed').length,
    },
  };
}

// One query per source, not one per address — a mailbox sweep easily turns up
// thousands of people.
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

// ── importing ───────────────────────────────────────────────────────────────
// Import the ticked addresses as ordinary CRM contacts, so they appear on the
// contacts page as well as the mailing lists — an address that only exists
// inside a marketing tool is one nobody will ever maintain.
//
// Suppressed addresses are refused outright rather than filtered quietly: being
// asked to re-add someone who unsubscribed deserves an answer, not a silence.
export async function importCandidates({ people, importedBy, runId = null }) {
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
    } else {
      const id = makeId('ct');
      // The note is the audit trail: months from now, "why is this person on
      // our marketing list" has an answer written next to them.
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

    if (runId) {
      await sql`
        UPDATE email_harvest_people SET imported_at = NOW()
         WHERE run_id = ${runId} AND email = ${email}`.catch(() => {});
    }
  }
  return results;
}
