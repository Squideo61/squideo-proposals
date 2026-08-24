// Marketing → Email. Compose one email, send it to a mailing list, watch what
// happens to it.
//
// Three ideas hold this together:
//
//   1. THE LIST IS DERIVED, NOT MAINTAINED. There is no subscribers table to
//      keep in sync with the CRM. "Everyone", "Customers" and "Non-customers"
//      are a query over the people the CRM already knows about — contacts plus
//      lead-magnet signups — so a contact added this morning is on the list
//      this afternoon without anyone importing anything.
//
//   2. SENDING IS A QUEUE, NOT A REQUEST. Pressing Send snapshots the audience
//      into email_campaign_recipients and returns. A cron drains the queue in
//      batches. A serverless function has 60 seconds; a mailing list does not
//      care, and a half-finished blast that timed out mid-way is the one
//      failure mode with no good recovery.
//
//   3. TRACKING REUSES THE EXISTING PIPELINE. Each recipient gets an ordinary
//      email_tracking row, so opens and clicks arrive through the same public
//      /api/track endpoints the CRM composer already uses, with the same geo
//      detail. Nothing new is exposed to the internet.
//
// Suppression and the unsubscribe footer are not optional extras here: the
// footer is written by the wrapper and the suppression check lives inside
// sendMarketingBatch, so neither is something a sender can forget.

import sql, { batchWrite } from '../db.js';
import { makeId, ensureDealContactsTable, ensureContactCompanies } from './shared.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { sendMail, sendMarketingBatch, BATCH_LIMIT } from '../email.js';
import {
  ensureSuppressionTable, listUnsubscribeHeaders, unsubscribeUrlFor,
} from '../emailSuppression.js';
import { instrumentHtml, newTrackingToken } from './trackingHtml.js';
import { ensureCourseTables } from '../course/db.js';
import {
  renderMergeTags, wrapCampaignHtml, htmlToText, stripUnsafeHtml, DEFAULT_CAMPAIGN_BODY,
} from './campaignHtml.js';
import { isValidEmail, assessEmail } from './emailAddress.js';
import { STAGES } from '../dealStage.js';

export const AUDIENCES = ['everyone', 'customers', 'non_customers'];
export const AUDIENCE_LABELS = {
  everyone: 'Everyone',
  customers: 'Customers',
  non_customers: 'Non-customers',
};

// What makes someone a customer: a deal that reached signed, paid or long-term.
// Anything earlier is a prospect, however warm it feels.
const WON_STAGES = STAGES.slice(STAGES.indexOf('signed'), STAGES.indexOf('lost'));

// Image types that actually render in an email client. SVG is deliberately not
// here: Gmail, Outlook and Apple Mail all refuse it, so accepting one would only
// produce a broken image in every inbox.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Every recipient downloads this, on whatever connection they have.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

let campaignImagesReady = null;
function ensureCampaignImages() {
  if (campaignImagesReady) return campaignImagesReady;
  campaignImagesReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS email_campaign_images (
        id            TEXT        PRIMARY KEY,
        campaign_id   TEXT        REFERENCES email_campaigns(id) ON DELETE SET NULL,
        filename      TEXT,
        mime_type     TEXT        NOT NULL,
        size_bytes    INTEGER,
        blob_url      TEXT        NOT NULL,
        blob_pathname TEXT,
        uploaded_by   TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    return true;
  })().catch((err) => {
    console.warn('[campaigns] image table ensure failed', err.message);
    campaignImagesReady = null;
    return false;
  });
  return campaignImagesReady;
}

// How much of the queue one cron run drains. 3 × 100 = 300 emails a minute,
// which clears a 5,000-person list in under 20 minutes while leaving headroom
// inside the 60s function budget and under Resend's request limit.
const BATCHES_PER_RUN = 3;

// ── schema self-heal ────────────────────────────────────────────────────────
// Migrations are applied by hand in Neon, so every table this module needs is
// also created at runtime. MUST NOT reject — a throwing self-heal has 500'd
// whole sections of this CRM before. A false return means "not ready".
let campaignTablesReady = null;
export function ensureCampaignTables() {
  if (campaignTablesReady) return campaignTablesReady;
  campaignTablesReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS email_campaigns (
        id            TEXT        PRIMARY KEY,
        name          TEXT        NOT NULL,
        audience      TEXT        NOT NULL DEFAULT 'everyone',
        subject       TEXT        NOT NULL DEFAULT '',
        preheader     TEXT,
        body_html     TEXT        NOT NULL DEFAULT '',
        reply_to      TEXT,
        status        TEXT        NOT NULL DEFAULT 'draft',
        scheduled_at  TIMESTAMPTZ,
        started_at    TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS email_campaign_recipients (
        id           BIGSERIAL   PRIMARY KEY,
        campaign_id  TEXT        NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
        email        TEXT        NOT NULL,
        name         TEXT,
        company_name TEXT,
        contact_id   TEXT,
        company_id   TEXT,
        is_customer  BOOLEAN     NOT NULL DEFAULT FALSE,
        status       TEXT        NOT NULL DEFAULT 'queued',
        tracking_id  BIGINT      REFERENCES email_tracking(id) ON DELETE SET NULL,
        provider_id  TEXT,
        error        TEXT,
        sent_at      TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS email_campaign_recipients_unique_idx
                ON email_campaign_recipients (campaign_id, email)`;
    await sql`CREATE INDEX IF NOT EXISTS email_campaign_recipients_queue_idx
                ON email_campaign_recipients (campaign_id, status)`;
    await sql`CREATE INDEX IF NOT EXISTS email_campaigns_status_idx
                ON email_campaigns (status)`;
    await sql`
      CREATE TABLE IF NOT EXISTS email_campaign_exclusions (
        campaign_id TEXT        NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
        email       TEXT        NOT NULL,
        reason      TEXT,
        created_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (campaign_id, email)
      )`;
    await sql`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS hourly_cap INTEGER`;
    await sql`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS daily_cap INTEGER`;
    await sql`ALTER TABLE email_campaign_recipients ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ`;
    await sql`ALTER TABLE email_campaign_recipients ADD COLUMN IF NOT EXISTS bounce_kind TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS email_campaign_recipients_provider_idx
                ON email_campaign_recipients (provider_id) WHERE provider_id IS NOT NULL`;
    return true;
  })().catch((err) => {
    console.warn('[campaigns] ensure failed', err.message);
    campaignTablesReady = null;   // let a later call retry
    return false;
  });
  return campaignTablesReady;
}

// Everything the audience query reads from, ensured together. Each is
// individually best-effort — a CRM that has never had a course signup still
// needs the contacts half of the union to work.
async function ensureAudienceSources() {
  await Promise.all([
    ensureCampaignTables(),
    ensureSuppressionTable(),
    ensureDealContactsTable().catch(() => {}),
    ensureContactCompanies().catch(() => {}),
    Promise.resolve(ensureCourseTables()).catch(() => {}),
  ]);
}

// Where an unsubscribe came from. The suppression row's `source` is whatever
// list name was baked into the unsubscribe link, so it says which email lost
// them — but `campaign:camp_abc123` means nothing to a person reading it.
async function suppressionSourceLabels() {
  const labels = {
    'one-click': 'a one-click unsubscribe',
    email: 'an unsubscribe link',
    course: 'the video guide emails',
    brief: 'the brief-builder emails',
    'campaign-test': 'a test send',
    marketing: 'a marketing email',
  };
  try {
    const rows = await sql`SELECT id, name FROM email_campaigns`;
    rows.forEach((r) => { labels['campaign:' + r.id] = r.name; });
  } catch { /* campaign table may not exist yet */ }
  return labels;
}

// One person's standing with us, as one word. Four states rather than a boolean
// because they call for different things: an explicit tick is evidence we can
// point at, a soft opt-in is a judgement we're relying on, an unsubscribe is a
// door closed, and a bounce is an address that no longer works.
export function consentStatus(row) {
  // Opt-outs are read FIRST, before the address is even examined. Someone who
  // unsubscribed and whose address is also malformed must show as unsubscribed:
  // both keep them off the list, but only one of them is a decision they made,
  // and a formatting problem must never be allowed to hide it.
  if (row.unsubscribed) {
    const bounced = row.suppression_scope === 'all'
      || (row.suppression_reason && row.suppression_reason !== 'unsubscribe');
    return bounced ? 'bounced' : 'unsubscribed';
  }
  // An address that isn't one can only ever bounce, and bounces are the number
  // a sending domain is judged on.
  if (!isValidEmail(row.email)) return 'invalid';
  return row.opted_in ? 'opted_in' : 'soft';
}

// ── the mailing lists ───────────────────────────────────────────────────────
// One query builds all three lists; `audience` only filters the result. That is
// deliberate — three separate queries would eventually disagree about what a
// customer is, and the count on the button would stop matching the people who
// actually receive the email.
//
// Unsubscribed people are FETCHED but not returned by default. They have to be
// visible somewhere: an unsubscribe applies across everything we send, so
// someone who opts out of one campaign vanishes from every other list too, and
// a person quietly disappearing with no way to see why or when is how you end
// up emailing them again by hand and getting a complaint. `includeUnsubscribed`
// is what the UI uses to show them, clearly marked, without ever putting them
// in a send.
// The whole list, cached briefly in the instance.
//
// Everything on this screen derives from one query — the lists, the counts, the
// search, the exclusion picker — and it is not a cheap query: three unions over
// contacts, lead-magnet signups and quote requests, with a customer test per
// person. Running it per keystroke (twice, as the search endpoint used to)
// makes a search box that looks broken.
//
// Sixty seconds is chosen against what the data actually does: a contact added
// while somebody is picking people to leave out changes nothing they can see,
// and the send path asks for a fresh copy anyway.
const AUDIENCE_TTL_MS = 60_000;
let audienceCache = null;   // { at, rows }

// Throw the cached list away. Called when something has just changed who is on
// it — importing people out of Gmail, most obviously — so the counts don't sit
// a minute behind an action the user just took and watched happen.
export function clearAudienceCache() {
  audienceCache = null;
}

async function allAudienceRows({ fresh = false } = {}) {
  if (!fresh && audienceCache && Date.now() - audienceCache.at < AUDIENCE_TTL_MS) {
    return audienceCache.rows;
  }
  const rows = await queryAudienceRows();
  audienceCache = { at: Date.now(), rows };
  return rows;
}

export async function audienceRows(audience = 'everyone', { includeUnsubscribed = false, fresh = false } = {}) {
  const all = await allAudienceRows({ fresh });
  const byAudience = audience === 'customers'
    ? all.filter((r) => r.isCustomer)
    : (audience === 'non_customers' ? all.filter((r) => !r.isCustomer) : all);
  return includeUnsubscribed
    ? byAudience
    : byAudience.filter((r) => !['unsubscribed', 'bounced', 'invalid'].includes(r.status));
}

async function queryAudienceRows() {
  await ensureAudienceSources();
  const rows = await sql`
    WITH won AS (
      SELECT id, company_id, primary_contact_id FROM deals WHERE stage = ANY(${WON_STAGES})
    ),
    customer_contacts AS (
      SELECT c.id FROM contacts c
       WHERE EXISTS (SELECT 1 FROM won w WHERE w.primary_contact_id = c.id)
          OR EXISTS (SELECT 1 FROM deal_contacts dc JOIN won w ON w.id = dc.deal_id
                      WHERE dc.contact_id = c.id)
          OR EXISTS (SELECT 1 FROM won w WHERE w.company_id IS NOT NULL AND w.company_id = c.company_id)
          OR EXISTS (SELECT 1 FROM contact_companies cc JOIN won w ON w.company_id = cc.company_id
                      WHERE cc.contact_id = c.id)
    ),
    people AS (
      -- CRM contacts. Provisional rows are half-captured addresses from email
      -- sync rather than people anyone chose to add, so they stay out.
      SELECT LOWER(TRIM(c.email)) AS email, c.name AS name, NULL::text AS company_name,
             c.id AS contact_id, c.company_id AS company_id,
             (cc.id IS NOT NULL) AS is_customer, 1 AS pref, 'contact' AS src
        FROM contacts c
        LEFT JOIN customer_contacts cc ON cc.id = c.id
       WHERE COALESCE(c.provisional, FALSE) = FALSE
         AND c.email IS NOT NULL AND POSITION('@' IN c.email) > 1
      UNION ALL
      -- Lead-magnet signups (the video guide and the online brief builder).
      -- Most never become a contact, and they are the warmest non-customers
      -- there are — leaving them out would empty the prospect list.
      SELECT LOWER(TRIM(s.email)), s.name, s.company_name,
             s.contact_id, s.company_id,
             (s.contact_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM customer_contacts cc WHERE cc.id = s.contact_id)) AS is_customer,
             2 AS pref, 'signup' AS src
        FROM course_signups s
       WHERE s.email IS NOT NULL AND POSITION('@' IN s.email) > 1
      UNION ALL
      -- Everyone who has ever asked us for a quote through the website.
      --
      -- These were missing, and they are the single most valuable non-customer
      -- list there is: a quote request is someone asking us to sell to them.
      -- They were invisible because a quote request only becomes a permanent
      -- contact when somebody converts it into a deal — the ones nobody
      -- followed up stayed provisional, which the contacts page and therefore
      -- these lists both filter out. Read straight from the source table so
      -- that stops being true.
      --
      -- Spam-marked requests are excluded: those addresses were never a person
      -- asking for anything.
      SELECT LOWER(TRIM(q.email)), q.name, q.company,
             q.contact_id, NULL::text,
             (q.contact_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM customer_contacts cc WHERE cc.id = q.contact_id)) AS is_customer,
             3 AS pref, 'quote' AS src
        FROM quote_requests q
       WHERE q.email IS NOT NULL AND POSITION('@' IN q.email) > 1
         AND COALESCE(q.status, 'new') <> 'spam'
    ),
    dedup AS (
      -- One row per address. A customer row beats a non-customer one and a
      -- contact beats a signup or a quote request, so nobody is counted twice
      -- or lands in both lists.
      SELECT DISTINCT ON (email) email, name, company_name, contact_id, company_id, is_customer, src
        FROM people
       ORDER BY email, is_customer DESC, pref ASC
    )
    SELECT d.email, d.name, COALESCE(co.name, d.company_name) AS company_name,
           d.contact_id, d.company_id, d.is_customer, d.src,
           -- The explicit tick, wherever it came from — the lead-magnet forms
           -- or the quote form. Most CRM contacts have neither and are on the
           -- soft opt-in basis instead, which the UI says out loud rather than
           -- implying a consent we were never given.
           (COALESCE(cs.marketing_consent, FALSE) OR COALESCE(qr.opt_in, FALSE)) AS opted_in,
           CASE WHEN COALESCE(cs.marketing_consent, FALSE) THEN cs.consent_at
                WHEN COALESCE(qr.opt_in, FALSE) THEN qr.opted_in_at END AS consent_at,
           CASE WHEN COALESCE(cs.marketing_consent, FALSE) THEN cs.consent_source
                WHEN COALESCE(qr.opt_in, FALSE) THEN 'quote' END AS consent_source,
           cs.consent_text,
           -- When they last asked us for something. The reason a cold-looking
           -- address is on the list at all, and the thing you want to see
           -- before writing to it.
           qr.last_enquiry_at,
           (s.email IS NOT NULL) AS unsubscribed,
           s.created_at AS unsubscribed_at, s.reason AS suppression_reason,
           s.source AS suppression_source, s.scope AS suppression_scope
      FROM dedup d
      LEFT JOIN companies co ON co.id = d.company_id
      LEFT JOIN LATERAL (
        SELECT cs2.marketing_consent, cs2.consent_at, cs2.consent_source, cs2.consent_text
          FROM course_signups cs2
         WHERE LOWER(TRIM(cs2.email)) = d.email
         ORDER BY cs2.marketing_consent DESC, cs2.consent_at DESC NULLS LAST
         LIMIT 1
      ) cs ON TRUE
      -- Aggregated, not LIMIT 1: someone who has asked for three quotes and
      -- ticked the box on one of them has ticked the box.
      LEFT JOIN LATERAL (
        SELECT BOOL_OR(q2.opt_in) AS opt_in,
               MAX(q2.created_at) AS last_enquiry_at,
               MAX(q2.created_at) FILTER (WHERE q2.opt_in) AS opted_in_at
          FROM quote_requests q2
         WHERE LOWER(TRIM(q2.email)) = d.email
           AND COALESCE(q2.status, 'new') <> 'spam'
      ) qr ON TRUE
      LEFT JOIN email_suppressions s ON s.email = d.email
     WHERE d.email NOT ILIKE '%@squideo.co.uk'
       AND d.email NOT ILIKE '%@squideo.com'
     ORDER BY d.is_customer DESC, d.email
  `;
  const labels = await suppressionSourceLabels();
  return rows.map((r) => ({
    email: r.email,
    name: r.name || null,
    companyName: r.company_name || null,
    contactId: r.contact_id || null,
    companyId: r.company_id || null,
    isCustomer: !!r.is_customer,
    // Where we got the address. Shown in the UI because "how did we come by
    // this person" is the question behind every other one on that screen.
    source: r.src || 'contact',
    lastEnquiryAt: r.last_enquiry_at || null,
    status: consentStatus(r),
    optedIn: !!r.opted_in,
    consentAt: r.consent_at || null,
    consentSource: r.consent_source || null,
    consentText: r.consent_text || null,
    unsubscribedAt: r.unsubscribed_at || null,
    // Which email they unsubscribed from, in words. "They left via the August
    // newsletter" is a fact you can act on; "campaign:camp_a91f" is not.
    unsubscribedFrom: r.suppression_source
      ? (labels[r.suppression_source] || r.suppression_source)
      : null,
  }));
}

// Counts for the three list cards, plus how many people the suppression list is
// holding back. That last number is worth showing — it's the one that explains
// why "Everyone" is smaller than the contacts page.
export async function audienceSummary() {
  const everyone = await allAudienceRows();
  const mailable = everyone.filter((r) => !['unsubscribed', 'bounced', 'invalid'].includes(r.status));
  const customers = mailable.filter((r) => r.isCustomer).length;
  // Counted off the same rows as the lists themselves, so "off the list" and
  // "on the list" always add up to the people we hold. A separate COUNT(*) on
  // the suppression table wouldn't: it also holds addresses we've never had a
  // contact record for.
  const unsubscribed = everyone.filter((r) => r.status === 'unsubscribed').length;
  const bounced = everyone.filter((r) => r.status === 'bounced').length;
  const invalid = everyone.filter((r) => r.status === 'invalid').length;
  return {
    everyone: mailable.length,
    customers,
    non_customers: mailable.length - customers,
    optedIn: mailable.filter((r) => r.optedIn).length,
    unsubscribed,
    bounced,
    invalid,
    suppressed: unsubscribed + bounced,
  };
}

// ── rendering ───────────────────────────────────────────────────────────────
// Builds the exact html one recipient receives: merge tags → tracking → wrapper
// (which adds the unsubscribe footer). Returns the links in the order the click
// endpoint refers to them by index.
export function renderForRecipient(campaign, recipient, token, { unsubscribeList = null } = {}) {
  const body = renderMergeTags(stripUnsafeHtml(campaign.bodyHtml || ''), recipient);
  const { html: instrumented, links } = token
    ? instrumentHtml(body, token)
    : { html: body, links: [] };
  const html = wrapCampaignHtml({
    bodyHtml: instrumented,
    preheader: renderMergeTags(campaign.preheader || '', recipient),
    // The list name lands in the suppression row's `source`, which is how the
    // report attributes an unsubscribe to the email that caused it. A test send
    // uses a different name so an accidental click while proof-reading doesn't
    // show up as the campaign losing a subscriber.
    unsubscribeUrl: unsubscribeUrlFor(recipient.email, unsubscribeList || `campaign:${campaign.id}`),
  });
  return {
    subject: renderMergeTags(campaign.subject || '', recipient),
    html,
    text: htmlToText(body),
    links,
  };
}

// ── the queue ───────────────────────────────────────────────────────────────
// Snapshot the audience. Runs once, when the campaign starts sending: from then
// on the campaign has a fixed recipient list, so a contact added mid-send
// doesn't get a half-finished blast, and nobody can receive it twice (the
// unique index on campaign_id + email is what actually guarantees that).
async function snapshotAudience(campaign) {
  const [people, excluded] = await Promise.all([
    // `fresh` on purpose: the browsing screens can live with a minute-old list,
    // but the moment that decides who actually receives this cannot.
    audienceRows(campaign.audience, { fresh: true }),
    campaignExclusions(campaign.id),
  ]);
  // Applied at snapshot time rather than at send time: excluding somebody has
  // to mean they never enter the queue, not that we notice on the way past.
  const skip = new Set(excluded.map((e) => e.email));
  const wanted = skip.size ? people.filter((p) => !skip.has(p.email)) : people;
  if (wanted.length) {
    await batchWrite(wanted.map((p) => sql`
      INSERT INTO email_campaign_recipients
        (campaign_id, email, name, company_name, contact_id, company_id, is_customer)
      VALUES (${campaign.id}, ${p.email}, ${p.name}, ${p.companyName},
              ${p.contactId}, ${p.companyId}, ${p.isCustomer})
      ON CONFLICT (campaign_id, email) DO NOTHING
    `));
  }
  const [row] = await sql`
    SELECT COUNT(*)::int AS n FROM email_campaign_recipients WHERE campaign_id = ${campaign.id}`;
  return row?.n || 0;
}

// Everyone with a live deal — in the pipeline, but not yet signed.
//
// The one group a general marketing email can actively damage. Someone
// mid-negotiation receiving a blanket "25% off this month" either undercuts the
// quote their salesperson is sitting on or reads as though nobody in the
// building knows they're already talking to us. Both are worse than not
// emailing them at all.
//
// Derived from the shared stage order rather than a list of its own: everything
// BEFORE 'signed'. Lost deals aren't live, and signed/paid/long-term are
// customers, so both are left alone.
const OPEN_STAGES = STAGES.slice(0, STAGES.indexOf('signed'));

export async function openDealEmails() {
  await ensureDealContactsTable().catch(() => {});
  const rows = await sql`
    WITH open_deals AS (
      SELECT id, title, stage, primary_contact_id FROM deals WHERE stage = ANY(${OPEN_STAGES})
    )
    -- The contact the deal is addressed to.
    SELECT LOWER(TRIM(c.email)) AS email, c.name, d.title, d.stage
      FROM open_deals d JOIN contacts c ON c.id = d.primary_contact_id
     WHERE c.email IS NOT NULL AND POSITION('@' IN c.email) > 1
    UNION
    -- Anyone else attached to it.
    SELECT LOWER(TRIM(c.email)), c.name, d.title, d.stage
      FROM open_deals d
      JOIN deal_contacts dc ON dc.deal_id = d.id
      JOIN contacts c ON c.id = dc.contact_id
     WHERE c.email IS NOT NULL AND POSITION('@' IN c.email) > 1
    UNION
    -- And the address the enquiry itself came from, which is the only record
    -- when the quote request was never converted into a contact.
    SELECT LOWER(TRIM(q.email)), q.name, d.title, d.stage
      FROM open_deals d JOIN quote_requests q ON q.deal_id = d.id
     WHERE q.email IS NOT NULL AND POSITION('@' IN q.email) > 1
  `.catch((err) => {
    console.warn('[campaigns] open-deal lookup failed', err.message);
    return [];
  });

  // One entry per address — somebody on three open deals is still one person.
  const byEmail = new Map();
  for (const r of rows) {
    if (!r.email || byEmail.has(r.email)) continue;
    byEmail.set(r.email, { email: r.email, name: r.name || null, deal: r.title || null, stage: r.stage });
  }
  return [...byEmail.values()];
}

// How old the list is, by the year we last heard from each person.
//
// The reason this exists: an address harvested from a 2018 enquiry is a
// different proposition from one that enquired last month. People change jobs,
// companies fold, mailboxes get deleted — and a dead address is not a wasted
// email, it is a bounce, which is the number the mailbox providers score a
// sending domain on. Being able to see where the list's weight sits, and cut a
// year off the back of it, is the difference between a campaign that lands and
// one that quietly damages the domain it went out from.
//
// Only people whose age we actually know are counted. Somebody with no enquiry
// on record isn't old — they're unknown, and guessing would exclude the wrong
// people.
export function audienceByAge(people, alreadyExcluded = new Set()) {
  const years = new Map();
  let unknown = 0;
  for (const p of people) {
    if (alreadyExcluded.has(p.email)) continue;
    if (!p.lastEnquiryAt) { unknown += 1; continue; }
    const year = new Date(p.lastEnquiryAt).getUTCFullYear();
    if (!Number.isFinite(year)) { unknown += 1; continue; }
    years.set(year, (years.get(year) || 0) + 1);
  }
  const known = [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
  // "Everyone before 2021" is the question people actually ask, so give the
  // running total each cutoff would remove.
  let running = 0;
  const cumulative = known.map(({ year, count }) => {
    running += count;
    return { year, count, upToAndIncluding: running };
  });
  return { years: cumulative, unknown, dated: running };
}

// The people whose last contact predates a cutoff.
export async function staleAudience(audience, beforeIso) {
  const cutoff = new Date(beforeIso);
  if (Number.isNaN(cutoff.getTime())) return [];
  const people = await audienceRows(audience);
  return people.filter((p) => p.lastEnquiryAt && new Date(p.lastEnquiryAt) < cutoff);
}

async function campaignExclusions(campaignId) {
  const rows = await sql`
    SELECT email, reason, created_by, created_at
      FROM email_campaign_exclusions WHERE campaign_id = ${campaignId}
     ORDER BY created_at DESC`.catch(() => []);
  return rows.map((r) => ({
    email: r.email, reason: r.reason || null,
    createdBy: r.created_by || null, createdAt: r.created_at,
  }));
}

// ── the speed limit ─────────────────────────────────────────────────────────
// How many more this campaign may send right now.
//
// A domain with no marketing history that suddenly posts four thousand emails
// in a quarter of an hour looks, to every mailbox provider, exactly like a
// compromised account. The caps are what turn a big list into a send that
// happens over days — which is what "warming up" actually is.
//
// Both windows are measured from the recipient rows themselves, so a restarted
// or resumed campaign can't reset its own allowance by forgetting.
async function sendAllowance(campaign) {
  const hourly = Number(campaign.hourlyCap) || null;
  const daily = Number(campaign.dailyCap) || null;
  if (!hourly && !daily) return BATCH_LIMIT;
  const [used] = await sql`
    SELECT COUNT(*) FILTER (WHERE sent_at > NOW() - interval '1 hour')::int  AS last_hour,
           COUNT(*) FILTER (WHERE sent_at > NOW() - interval '24 hours')::int AS last_day
      FROM email_campaign_recipients
     WHERE campaign_id = ${campaign.id} AND status = 'sent'`;
  const room = [BATCH_LIMIT];
  if (hourly) room.push(hourly - (used?.last_hour || 0));
  if (daily) room.push(daily - (used?.last_day || 0));
  return Math.max(0, Math.min(...room));
}

// When the next batch will go, and when the whole thing should be done.
//
// READ-ONLY, and deliberately separate from sendAllowance: this runs while a
// campaign is mid-flight, and nothing on a reporting path should be able to
// affect a send. It mirrors the same rule rather than sharing the code, so a
// change here can never alter what actually goes out.
//
// The rule it mirrors: a cap is a rolling window, so the next slot opens when
// the OLDEST send inside that window ages out of it. With 150 an hour, sending
// 150 at 16:12 means nothing more until 17:12 — which from the outside looks
// exactly like a campaign that has stalled, hence this.
export async function campaignPace(campaign) {
  const hourly = Number(campaign.hourlyCap) || null;
  const daily = Number(campaign.dailyCap) || null;
  try {
    const [row] = await sql`
      SELECT COUNT(*) FILTER (WHERE sent_at > NOW() - interval '1 hour')::int   AS last_hour,
             COUNT(*) FILTER (WHERE sent_at > NOW() - interval '24 hours')::int AS last_day,
             MIN(sent_at) FILTER (WHERE sent_at > NOW() - interval '1 hour')    AS oldest_in_hour,
             MIN(sent_at) FILTER (WHERE sent_at > NOW() - interval '24 hours')  AS oldest_in_day,
             COUNT(*) FILTER (WHERE status IN ('queued', 'sending'))::int       AS remaining
        FROM email_campaign_recipients
       WHERE campaign_id = ${campaign.id}`;
    if (!row) return null;

    const lastHour = row.last_hour || 0;
    const lastDay = row.last_day || 0;
    const remaining = row.remaining || 0;

    const room = [BATCH_LIMIT];
    if (hourly) room.push(hourly - lastHour);
    if (daily) room.push(daily - lastDay);
    const allowance = Math.max(0, Math.min(...room));

    // Which cap is holding it up, and when that cap next lets something
    // through. If several are, the later one wins.
    let nextBatchAt = null;
    if (allowance <= 0) {
      const opens = [];
      if (hourly && hourly - lastHour <= 0 && row.oldest_in_hour) {
        opens.push(new Date(row.oldest_in_hour).getTime() + 60 * 60 * 1000);
      }
      if (daily && daily - lastDay <= 0 && row.oldest_in_day) {
        opens.push(new Date(row.oldest_in_day).getTime() + 24 * 60 * 60 * 1000);
      }
      if (opens.length) nextBatchAt = new Date(Math.max(...opens)).toISOString();
    }

    // What it can actually manage in a day: the hourly cap 24 times over, or
    // the daily cap, whichever bites first.
    const perDay = daily && hourly ? Math.min(daily, hourly * 24) : (daily || (hourly ? hourly * 24 : null));
    const finishAt = remaining > 0 && perDay
      ? new Date(Date.now() + Math.ceil(remaining / perDay) * 24 * 60 * 60 * 1000).toISOString()
      : null;

    return {
      hourlyCap: hourly,
      dailyCap: daily,
      sentLastHour: lastHour,
      sentLastDay: lastDay,
      remaining,
      // How many the next batch can carry — 0 means it's waiting on a cap.
      nextBatchSize: allowance,
      nextBatchAt,
      perDay,
      finishAt,
    };
  } catch (err) {
    // Never let a reporting query be the reason a page fails while a campaign
    // is running.
    console.warn('[campaigns] pace read failed', err.message);
    return null;
  }
}

// Send one batch for one campaign. Returns how many recipients it handled — 0
// means the queue is empty and the campaign can be closed off.
//
// The claim is a single UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED), so
// two overlapping runs can never claim the same recipient. That property is the
// only thing standing between a slow send and someone receiving the campaign
// twice, which is why it's one statement rather than a select then an update.
async function sendBatch(campaign) {
  const allowance = await sendAllowance(campaign);
  // Throttled out for now. Not finished — the queue still has people in it, so
  // the caller must not close the campaign off.
  if (allowance <= 0) return { sent: 0, throttled: true };

  const claimed = await sql`
    UPDATE email_campaign_recipients r
       SET status = 'sending'
      FROM (
        SELECT id FROM email_campaign_recipients
         WHERE campaign_id = ${campaign.id} AND status = 'queued'
         ORDER BY id
         LIMIT ${allowance}
         FOR UPDATE SKIP LOCKED
      ) c
     WHERE r.id = c.id
    RETURNING r.id, r.email, r.name, r.company_name
  `;
  if (!claimed.length) return { sent: 0, throttled: false };

  const recipients = claimed.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    companyName: r.company_name,
  }));

  // A tracking row per recipient — its token is what the pixel and the
  // rewritten links carry, so opens and clicks come back attributable to one
  // person rather than to the campaign as a whole.
  const tokens = recipients.map(() => newTrackingToken());
  const rendered = recipients.map((r, i) => renderForRecipient(campaign, r, tokens[i]));

  let trackingByToken = new Map();
  try {
    const inserted = await sql`
      INSERT INTO email_tracking (token, user_email, subject, recipients, source)
      SELECT x.t, ${'system:campaign:' + campaign.id}, ${campaign.subject || null}, ARRAY[x.e], 'campaign'
        FROM UNNEST(${tokens}::text[], ${recipients.map((r) => r.email)}::text[]) AS x(t, e)
      ON CONFLICT (token) DO NOTHING
      RETURNING id, token
    `;
    trackingByToken = new Map(inserted.map((row) => [row.token, row.id]));

    // The rewritten links, so /api/track/click resolves a destination from our
    // own tables and never from the query string. Same links for everyone, but
    // each tracking row needs its own copy to join against.
    const ids = [], idxs = [], urls = [];
    rendered.forEach((r, i) => {
      const trackingId = trackingByToken.get(tokens[i]);
      if (!trackingId) return;
      r.links.forEach((url, idx) => { ids.push(trackingId); idxs.push(idx); urls.push(url); });
    });
    if (ids.length) {
      await sql`
        INSERT INTO email_tracking_links (tracking_id, idx, url)
        SELECT x.tid, x.i, x.u
          FROM UNNEST(${ids}::bigint[], ${idxs}::int[], ${urls}::text[]) AS x(tid, i, u)
        ON CONFLICT (tracking_id, idx) DO NOTHING
      `;
    }
  } catch (err) {
    // Tracking is best-effort: an email that goes out unmeasured beats an email
    // that doesn't go out.
    console.error('[campaigns] tracking insert failed', err.message);
  }

  const results = await sendMarketingBatch(recipients.map((r, i) => ({
    to: r.email,
    subject: rendered[i].subject,
    html: rendered[i].html,
    text: rendered[i].text,
    replyTo: campaign.replyTo || null,
    headers: listUnsubscribeHeaders(r.email, `campaign:${campaign.id}`),
  })));

  // A rate limit or a daily quota is the provider saying "not now", not "never"
  // — those recipients go back on the queue for the next run rather than being
  // written off. Getting this wrong on a plan with a daily cap would silently
  // fail most of a campaign and report it as sent.
  let requeued = 0;
  await batchWrite(recipients.map((r, i) => {
    const result = results[i] || { ok: false, error: 'No result' };
    const retry = !result.ok && !result.suppressed && result.retryable;
    if (retry) requeued += 1;
    const status = result.ok ? 'sent' : (result.suppressed ? 'skipped' : (retry ? 'queued' : 'failed'));
    const trackingId = trackingByToken.get(tokens[i]) || null;
    return sql`
      UPDATE email_campaign_recipients
         SET status = ${status},
             tracking_id = ${trackingId},
             provider_id = ${result.id || null},
             error = ${result.ok || retry ? null : (result.error || 'Send failed')},
             sent_at = ${result.ok ? new Date().toISOString() : null}
       WHERE id = ${r.id}
    `;
  }));

  if (requeued) {
    console.warn('[campaigns] batch deferred by the sender', { id: campaign.id, requeued });
    // Stop this run: whatever the provider is unhappy about, hammering it with
    // the next batch a second later will not help.
    return { sent: recipients.length - requeued, throttled: true };
  }
  return { sent: recipients.length, throttled: false };
}

// Drain whatever is due: scheduled campaigns whose time has come, plus any
// campaign already mid-send. Called by the cron every minute, and once inline
// when someone presses Send so the first emails leave immediately rather than
// up to a minute later.
export async function drainCampaigns({ batches = BATCHES_PER_RUN, campaignId = null } = {}) {
  const ready = await ensureCampaignTables();
  if (!ready) return { ok: false, error: 'Campaign tables unavailable' };

  // Scheduled → sending, once their moment arrives.
  await sql`
    UPDATE email_campaigns
       SET status = 'sending', updated_at = NOW()
     WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
  `.catch((err) => console.warn('[campaigns] schedule promote failed', err.message));

  const due = campaignId
    ? await sql`SELECT * FROM email_campaigns WHERE id = ${campaignId} AND status = 'sending'`
    : await sql`SELECT * FROM email_campaigns WHERE status = 'sending'
                 ORDER BY started_at ASC NULLS FIRST LIMIT 3`;

  let sent = 0;
  const completed = [];
  for (const row of due) {
    const campaign = serialiseCampaign(row);
    // A scheduled campaign is snapshotted the first time it actually runs, not
    // when it was scheduled — so a list that grew overnight is the list it goes
    // to. started_at is what records that this has happened.
    if (!campaign.startedAt) {
      await snapshotAudience(campaign).catch((err) => {
        console.error('[campaigns] snapshot failed', { id: campaign.id, err: err.message });
      });
      await sql`UPDATE email_campaigns SET started_at = NOW() WHERE id = ${campaign.id}`;
    }
    let throttled = false;
    for (let b = 0; b < batches; b++) {
      let result = { sent: 0, throttled: false };
      try { result = await sendBatch(campaign); }
      catch (err) {
        console.error('[campaigns] batch failed', { id: campaign.id, err: err.message });
        break;
      }
      if (result.throttled) { throttled = true; break; }
      if (!result.sent) break;
      sent += result.sent;
    }
    const [remaining] = await sql`
      SELECT COUNT(*)::int AS n FROM email_campaign_recipients
       WHERE campaign_id = ${campaign.id} AND status IN ('queued', 'sending')`;
    // A throttled campaign is mid-send, not finished — closing it off here
    // would strand everyone still queued behind the cap.
    if (!remaining?.n && !throttled) {
      await sql`
        UPDATE email_campaigns SET status = 'sent', completed_at = NOW(), updated_at = NOW()
         WHERE id = ${campaign.id} AND status = 'sending'`;
      completed.push(campaign.id);
    }
  }
  return { ok: true, campaigns: due.length, sent, completed };
}

// ── stats ───────────────────────────────────────────────────────────────────
// Opens and clicks are counted BOTH ways on purpose. Unique counts answer "how
// many people", totals answer "how much interest" — a campaign one person
// opened nine times is a very different result from nine people opening once,
// and a single "opens" number hides which one you got.
export async function campaignStats(campaignId) {
  const [counts] = await sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'sent')::int    AS sent,
           COUNT(*) FILTER (WHERE status = 'queued')::int  AS queued,
           COUNT(*) FILTER (WHERE status = 'sending')::int AS sending,
           COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
           COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
           COUNT(*) FILTER (WHERE bounced_at IS NOT NULL AND bounce_kind = 'hard')::int AS bounced,
           COUNT(*) FILTER (WHERE bounce_kind = 'complaint')::int AS complaints
      FROM email_campaign_recipients WHERE campaign_id = ${campaignId}`;
  const [engagement] = await sql`
    SELECT COUNT(DISTINCT r.id) FILTER (WHERE e.kind = 'open')::int  AS opened,
           COUNT(*)             FILTER (WHERE e.kind = 'open')::int  AS opens,
           COUNT(DISTINCT r.id) FILTER (WHERE e.kind = 'click')::int AS clicked,
           COUNT(*)             FILTER (WHERE e.kind = 'click')::int AS clicks
      FROM email_campaign_recipients r
      LEFT JOIN email_tracking_events e ON e.tracking_id = r.tracking_id
     WHERE r.campaign_id = ${campaignId}`;
  // Attributed through the unsubscribe token, which carries the campaign id —
  // so this is "unsubscribed BECAUSE of this email", not "unsubscribed at some
  // point since".
  const unsub = await sql`
    SELECT COUNT(*)::int AS n FROM email_suppressions
     WHERE source = ${'campaign:' + campaignId}`.catch(() => [{ n: 0 }]);

  const sent = counts?.sent || 0;
  const rate = (n) => (sent > 0 ? Math.round((n / sent) * 1000) / 10 : 0);
  const opened = engagement?.opened || 0;
  const clicked = engagement?.clicked || 0;
  const unsubscribed = unsub?.[0]?.n || 0;
  return {
    total: counts?.total || 0,
    sent,
    queued: counts?.queued || 0,
    sending: counts?.sending || 0,
    failed: counts?.failed || 0,
    skipped: counts?.skipped || 0,
    bounced: counts?.bounced || 0,
    complaints: counts?.complaints || 0,
    // The two numbers every mailbox provider judges us on. Shown as rates
    // because the thresholds are rates: roughly 2% for bounces, and Google
    // publishes 0.3% for complaints.
    bounceRate: rate(counts?.bounced || 0),
    complaintRate: rate(counts?.complaints || 0),
    opened,
    opens: engagement?.opens || 0,
    clicked,
    clicks: engagement?.clicks || 0,
    unsubscribed,
    openRate: rate(opened),
    clickRate: rate(clicked),
    unsubscribeRate: rate(unsubscribed),
    // Click-to-open: of the people who actually read it, how many acted. The
    // honest measure of whether the email itself worked, with the subject
    // line's effect taken out.
    clickToOpenRate: opened > 0 ? Math.round((clicked / opened) * 1000) / 10 : 0,
  };
}

// Bounce rate by how old the address is.
//
// "Cut the old ones" is only advice until you can see WHERE the dead addresses
// actually are. This puts a number on each year, so the cutoff is a decision
// made on evidence from this very send rather than a guess: if 2018 bounces at
// 40% and 2023 at 1%, the line draws itself.
//
// Read-only, and only over recipients this campaign has already tried.
export async function bounceByAge(campaignId) {
  const rows = await sql`
    SELECT EXTRACT(YEAR FROM q.last_at)::int AS year,
           COUNT(*)::int AS attempted,
           COUNT(*) FILTER (WHERE r.bounce_kind = 'hard')::int AS bounced
      FROM email_campaign_recipients r
      LEFT JOIN LATERAL (
        SELECT MAX(q2.created_at) AS last_at
          FROM quote_requests q2
         WHERE LOWER(TRIM(q2.email)) = r.email
           AND COALESCE(q2.status, 'new') <> 'spam'
      ) q ON TRUE
     WHERE r.campaign_id = ${campaignId}
       AND (r.status IN ('sent', 'bounced') OR r.bounced_at IS NOT NULL)
     GROUP BY 1
     ORDER BY 1
  `.catch((err) => {
    console.warn('[campaigns] bounce-by-age failed', err.message);
    return [];
  });

  return rows.map((r) => ({
    // NULL year = no enquiry on record. Reported as its own row rather than
    // folded in: it's a different question, and often a different answer.
    year: r.year ?? null,
    attempted: r.attempted || 0,
    bounced: r.bounced || 0,
    rate: r.attempted ? Math.round((r.bounced / r.attempted) * 1000) / 10 : 0,
  }));
}

async function campaignLinks(campaignId) {
  const rows = await sql`
    SELECT e.link_url AS url,
           COUNT(*)::int AS clicks,
           COUNT(DISTINCT r.id)::int AS people
      FROM email_campaign_recipients r
      JOIN email_tracking_events e ON e.tracking_id = r.tracking_id AND e.kind = 'click'
     WHERE r.campaign_id = ${campaignId} AND e.link_url IS NOT NULL
     GROUP BY e.link_url
     ORDER BY clicks DESC
     LIMIT 50`;
  return rows.map((r) => ({ url: r.url, clicks: r.clicks, people: r.people }));
}

// Per-person engagement. This is the half of the report that's actually
// actionable: "who opened it three times and clicked the pricing link" is a
// call worth making, where an open rate is only ever a scoreboard.
async function campaignRecipients(campaignId, { filter = 'all', limit = 1000 } = {}) {
  const rows = await sql`
    SELECT r.id, r.email, r.name, r.company_name, r.contact_id, r.is_customer,
           r.status, r.error, r.sent_at,
           -- Their standing NOW, not at send time. Someone who opted out after
           -- this went out matters, and it matters whether they left through
           -- this email or a different one.
           (sup.email IS NOT NULL) AS unsubscribed,
           sup.created_at AS unsubscribed_at, sup.source AS suppression_source,
           COALESCE(cs.marketing_consent, FALSE) AS opted_in,
           COUNT(e.id) FILTER (WHERE e.kind = 'open')::int  AS opens,
           COUNT(e.id) FILTER (WHERE e.kind = 'click')::int AS clicks,
           MIN(e.occurred_at) FILTER (WHERE e.kind = 'open') AS first_open_at,
           MAX(e.occurred_at) FILTER (WHERE e.kind = 'open') AS last_open_at,
           (ARRAY_AGG(e.city ORDER BY e.occurred_at DESC)
              FILTER (WHERE e.city IS NOT NULL))[1] AS city,
           (ARRAY_AGG(e.country ORDER BY e.occurred_at DESC)
              FILTER (WHERE e.country IS NOT NULL))[1] AS country
      FROM email_campaign_recipients r
      LEFT JOIN email_tracking_events e ON e.tracking_id = r.tracking_id
      LEFT JOIN email_suppressions sup ON sup.email = r.email
      LEFT JOIN LATERAL (
        SELECT cs2.marketing_consent FROM course_signups cs2
         WHERE LOWER(TRIM(cs2.email)) = r.email
         ORDER BY cs2.marketing_consent DESC LIMIT 1
      ) cs ON TRUE
     WHERE r.campaign_id = ${campaignId}
     GROUP BY r.id, sup.email, sup.created_at, sup.source, cs.marketing_consent
     ORDER BY clicks DESC, opens DESC, r.email
     LIMIT ${Math.min(Number(limit) || 1000, 2000)}`;
  const labels = await suppressionSourceLabels();
  const mapped = rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name || null,
    companyName: r.company_name || null,
    contactId: r.contact_id || null,
    isCustomer: !!r.is_customer,
    status: r.status,
    error: r.error || null,
    sentAt: r.sent_at,
    opens: r.opens || 0,
    clicks: r.clicks || 0,
    firstOpenAt: r.first_open_at,
    lastOpenAt: r.last_open_at,
    city: r.city || null,
    country: r.country || null,
    optedIn: !!r.opted_in,
    unsubscribed: !!r.unsubscribed,
    unsubscribedAt: r.unsubscribed_at || null,
    unsubscribedFrom: r.suppression_source
      ? (labels[r.suppression_source] || r.suppression_source)
      : null,
    // Did THIS email lose them, or had they already gone? The report is being
    // read to judge the email, and blaming it for someone else's unsubscribe is
    // the easiest wrong conclusion to draw from this screen.
    unsubscribedHere: r.suppression_source === 'campaign:' + campaignId,
  }));
  if (filter === 'unsubscribed') return mapped.filter((r) => r.unsubscribed);
  if (filter === 'opened') return mapped.filter((r) => r.opens > 0);
  if (filter === 'clicked') return mapped.filter((r) => r.clicks > 0);
  if (filter === 'unopened') return mapped.filter((r) => r.status === 'sent' && r.opens === 0);
  if (filter === 'failed') return mapped.filter((r) => r.status === 'failed');
  return mapped;
}

function serialiseCampaign(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    audience: row.audience,
    subject: row.subject || '',
    preheader: row.preheader || '',
    bodyHtml: row.body_html || '',
    replyTo: row.reply_to || null,
    hourlyCap: row.hourly_cap || null,
    dailyCap: row.daily_cap || null,
    status: row.status,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const trimOrNull = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
};

// ── repairing stored addresses ──────────────────────────────────────────────
// Walks the tables the mailing lists are built from, and fixes what it can.
// Bounded per call: a re-parse costs a Gmail round trip, and this runs inside a
// request. `more` tells the caller to press it again.
const REPARSE_LIMIT = 40;

async function fixStoredAddresses({ userEmail }) {
  const report = { checked: 0, repaired: [], unusable: [], more: false };

  // Everything the lists read from, with the row's own source of truth where it
  // has one.
  const [quotes, contacts, signups] = await Promise.all([
    sql`SELECT id, email, source_message_id FROM quote_requests
         WHERE email IS NOT NULL AND COALESCE(status, 'new') <> 'spam'`.catch(() => []),
    sql`SELECT id, email FROM contacts
         WHERE email IS NOT NULL AND COALESCE(provisional, FALSE) = FALSE`.catch(() => []),
    sql`SELECT id, email FROM course_signups WHERE email IS NOT NULL`.catch(() => []),
  ]);

  const suspect = [];
  const consider = (table, row) => {
    report.checked += 1;
    const assessment = assessEmail(row.email);
    if (assessment.verdict === 'ok') return;
    suspect.push({ table, row, assessment });
  };
  quotes.forEach((r) => consider('quote_requests', r));
  contacts.forEach((r) => consider('contacts', r));
  signups.forEach((r) => consider('course_signups', r));
  if (!suspect.length) return report;

  // Re-parse from Gmail first, for the rows that can be checked against the
  // email they came from.
  let accessToken = null;
  const reparsable = suspect.filter((s) => s.row.source_message_id).slice(0, REPARSE_LIMIT);
  report.more = suspect.filter((s) => s.row.source_message_id).length > reparsable.length;
  if (reparsable.length) {
    try {
      const { getFreshAccessToken } = await import('./gmail.js');
      accessToken = await getFreshAccessToken(userEmail);
    } catch (err) {
      console.warn('[campaigns] address repair: no Gmail access', err.message);
    }
  }

  for (const item of suspect) {
    let fixed = null;
    let how = null;

    if (accessToken && reparsable.includes(item)) {
      const fromSource = await reparseAddress(item.row.source_message_id, accessToken).catch(() => null);
      if (fromSource) { fixed = fromSource; how = 'read again from the original email'; }
    }
    if (!fixed && item.assessment.verdict === 'repaired') {
      fixed = item.assessment.email;
      how = 'repaired the address';
    }

    if (!fixed) {
      report.unusable.push({ table: item.table, id: item.row.id, email: item.row.email });
      continue;
    }
    if (fixed === String(item.row.email || '').toLowerCase()) continue;

    // If the broken address was suppressed, the corrected one inherits it.
    // Otherwise a repair quietly puts somebody who opted out back on the list —
    // correcting a typo is not consent.
    try {
      const [wasSuppressed] = await sql`
        SELECT scope, reason FROM email_suppressions
         WHERE email = ${String(item.row.email || '').toLowerCase()}`;
      if (wasSuppressed) {
        const { suppress } = await import('../emailSuppression.js');
        await suppress({
          email: fixed,
          scope: wasSuppressed.scope || 'marketing',
          reason: wasSuppressed.reason || 'unsubscribe',
          source: 'address-repair',
        });
      }
    } catch (err) {
      console.warn('[campaigns] could not carry suppression to repaired address', err.message);
    }

    try {
      if (item.table === 'quote_requests') {
        await sql`UPDATE quote_requests SET email = ${fixed} WHERE id = ${item.row.id}`;
      } else if (item.table === 'contacts') {
        await sql`UPDATE contacts SET email = ${fixed}, updated_at = NOW() WHERE id = ${item.row.id}`;
      } else {
        await sql`UPDATE course_signups SET email = ${fixed} WHERE id = ${item.row.id}`;
      }
      report.repaired.push({ table: item.table, id: item.row.id, from: item.row.email, to: fixed, how });
    } catch (err) {
      // A unique-index clash means the corrected address is already on file —
      // the mangled row is a duplicate, not a person we're about to lose.
      console.warn('[campaigns] could not write repaired address', err.message);
      report.unusable.push({
        table: item.table, id: item.row.id, email: item.row.email,
        note: 'The corrected address is already in the CRM',
      });
    }
  }
  return report;
}

// Read the enquiry out of its original notification email again.
async function reparseAddress(messageId, accessToken) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set('format', 'full');
  const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!res.ok) return null;
  const msg = await res.json();
  const { parseQuoteRequestEmail } = await import('./quoteEmailParser.js');
  const { extractBody, parseHeaders } = await import('../gmailSync.js');
  const headers = parseHeaders(msg.payload?.headers || []);
  const { html, text } = extractBody(msg.payload);
  const parsed = parseQuoteRequestEmail({
    subject: headers.subject,
    body: text,
    html,
    internalDomains: ['squideo.co.uk', 'squideo.com'],
  });
  return parsed?.email || null;
}

// ── route ───────────────────────────────────────────────────────────────────
export async function campaignsRoute(req, res, id, action, user) {
  res.setHeader('Cache-Control', 'no-store');
  const role = await getRole(user.role);
  if (!hasPermission(role, 'marketing.access')) {
    return res.status(403).json({ error: 'You do not have permission to view Marketing' });
  }
  await ensureCampaignTables();

  // GET /campaigns/audience — the three list cards, with a sample of who's on
  // the selected one. The sample matters: "3,412 people" is a number nobody can
  // check, and this is the last screen before an email leaves the building.
  if (id === 'audience' && req.method === 'GET') {
    const audience = AUDIENCES.includes(req.query.list) ? req.query.list : 'everyone';
    // `status` filters what's shown, never what's sent. 'unsubscribed' and
    // 'bounced' are the reason this endpoint returns people who are NOT on the
    // list: they're the only way to see that someone opted out of a different
    // email and has therefore gone from this one too.
    const status = String(req.query.status || 'mailable');
    const q = String(req.query.q || '').trim().toLowerCase();
    // Always fetched WITH the opt-outs, whatever is being shown: the tab counts
    // have to include the people who aren't on the list, or "Unsubscribed 0"
    // would read as nobody having unsubscribed.
    //
    // The whole-workspace summary is skipped while searching — a search box
    // doesn't show those counts, and computing them was doubling the work on
    // every keystroke.
    const rows = await audienceRows(audience, { includeUnsubscribed: true });
    const counts = q ? null : await audienceSummary();
    const mailable = rows.filter((r) => !['unsubscribed', 'bounced', 'invalid'].includes(r.status));
    let shown = status === 'all' ? rows
      : status === 'opted_in' ? mailable.filter((r) => r.optedIn)
      : status === 'soft' ? mailable.filter((r) => !r.optedIn)
      : status === 'unsubscribed' ? rows.filter((r) => r.status === 'unsubscribed')
      : status === 'bounced' ? rows.filter((r) => r.status === 'bounced')
      : status === 'invalid' ? rows.filter((r) => r.status === 'invalid')
      : mailable;

    // Free-text search across the whole list, not just the page on screen —
    // finding one person to leave out of a list of four thousand is the entire
    // job, and a filter that only searches the visible 300 can't do it.
    if (q) {
      shown = shown.filter((r) => [r.email, r.name, r.companyName]
        .some((v) => v && String(v).toLowerCase().includes(q)));
    }
    return res.status(200).json({
      counts,
      audience,
      status,
      // What a send to this list would actually reach, whatever is on screen.
      total: mailable.length,
      breakdown: {
        mailable: mailable.length,
        optedIn: mailable.filter((r) => r.optedIn).length,
        soft: mailable.filter((r) => !r.optedIn).length,
        unsubscribed: rows.filter((r) => r.status === 'unsubscribed').length,
        bounced: rows.filter((r) => r.status === 'bounced').length,
        invalid: rows.filter((r) => r.status === 'invalid').length,
      },
      shown: shown.length,
      sample: shown.slice(0, 300),
      query: q || null,
    });
  }

  // GET /campaigns/template — the starter body, so the composer can drop it
  // into a draft that's been emptied out without duplicating the html here.
  if (id === 'template' && req.method === 'GET') {
    return res.status(200).json({ bodyHtml: DEFAULT_CAMPAIGN_BODY });
  }

  // GET /campaigns/harvest — the search presets, so the UI doesn't hard-code
  // Gmail query syntax of its own.
  if (id === 'harvest' && req.method === 'GET') {
    const { HARVEST_PRESETS } = await import('./gmailHarvest.js');
    return res.status(200).json({ presets: HARVEST_PRESETS });
  }

  // GET /campaigns/harvest/run — the current (or last) sweep and what it has
  // turned up so far. Polled while one is running.
  if (id === 'harvest' && action === 'run' && req.method === 'GET') {
    const { latestHarvestRun, harvestPeople } = await import('./gmailHarvest.js');
    const run = await latestHarvestRun(user.email);
    if (!run) return res.status(200).json({ run: null, people: [], counts: null });
    const found = await harvestPeople(run.id);
    return res.status(200).json({ run, ...found });
  }

  // POST /campaigns/harvest — start a sweep of the WHOLE mailbox. Returns as
  // soon as the run exists; a cron works through it. One batch runs inline so
  // the first results are on screen immediately.
  if (id === 'harvest' && !action && req.method === 'POST') {
    const query = trimOrNull(req.body?.query);
    if (!query) return res.status(400).json({ error: 'What should I search for?' });
    const ingest = req.body?.ingest === true;
    try {
      const { startHarvestRun, sweepHarvestRun, latestHarvestRun, harvestPeople } = await import('./gmailHarvest.js');
      const runId = await startHarvestRun({
        userEmail: user.email, query, ingest,
        mode: trimOrNull(req.body?.mode) || 'people',
        startedBy: user.email,
      });
      // Listing is cheap (500 ids a call), so this first slice usually knows
      // the full size of the job by the time the request returns.
      await sweepHarvestRun({ runId, budgetMs: 20000 }).catch((err) => {
        console.error('[campaigns] inline sweep failed', err.message);
      });
      const run = await latestHarvestRun(user.email);
      const found = await harvestPeople(runId);
      return res.status(200).json({ run, ...found });
    } catch (err) {
      if (err.code === 'ALREADY_RUNNING') {
        return res.status(409).json({ error: 'A sweep is already running — let it finish or stop it first.' });
      }
      if (err.code === 'NOT_CONNECTED') {
        return res.status(400).json({ error: 'Connect your Gmail account first (Account → Email).' });
      }
      console.error('[campaigns] harvest failed', err.message);
      return res.status(502).json({ error: err.message || 'Could not search Gmail' });
    }
  }

  // POST /campaigns/harvest/stop — leave what's been found, stop reading.
  if (id === 'harvest' && action === 'stop' && req.method === 'POST') {
    const { cancelHarvestRun, latestHarvestRun } = await import('./gmailHarvest.js');
    const run = await latestHarvestRun(user.email);
    if (run) await cancelHarvestRun(run.id);
    return res.status(200).json({ ok: true, run: await latestHarvestRun(user.email) });
  }

  // POST /campaigns/harvest/import — add the ticked people as contacts. A
  // separate call from the search on purpose: nothing this reads out of a
  // mailbox reaches a mailing list without somebody choosing it.
  if (id === 'harvest' && action === 'import' && req.method === 'POST') {
    const people = Array.isArray(req.body?.people) ? req.body.people : [];
    if (!people.length) return res.status(400).json({ error: 'Nobody selected' });
    const { importCandidates } = await import('./gmailHarvest.js');
    const result = await importCandidates({
      people, importedBy: user.email, runId: trimOrNull(req.body?.runId),
    });
    // Those people are on the lists as of now, and the screen that just added
    // them is about to ask for the counts.
    clearAudienceCache();
    return res.status(200).json(result);
  }

  // POST /campaigns/audience/fix-addresses — check every stored address and
  // repair what can be repaired.
  //
  // Two mechanisms, strongest first:
  //   1. RE-PARSE FROM THE ORIGINAL EMAIL. An imported quote request remembers
  //      the message it came out of, so the true address can be read again with
  //      a parser that no longer collapses the labels into the value. This is
  //      evidence, not inference.
  //   2. REPAIR THE STRING. For rows with no source message, strip the label
  //      word welded to the address ("…@gmail.comphone"). Conservative: any
  //      repair that doesn't come out valid is refused, and the row is left for
  //      a human instead.
  if (id === 'audience' && action === 'fix-addresses' && req.method === 'POST') {
    const result = await fixStoredAddresses({ userEmail: user.email });
    clearAudienceCache();
    return res.status(200).json(result);
  }

  // POST /campaigns/audience/resubscribe — put someone back on, at their own
  // request. Deliberately an explicit, logged action rather than a quiet edit:
  // undoing someone's opt-out is only ever legitimate when they asked for it,
  // so the reason is recorded and the caller has to say who asked.
  if (id === 'audience' && action === 'resubscribe' && req.method === 'POST') {
    const email = trimOrNull(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Which address?' });
    const { unsuppress } = await import('../emailSuppression.js');
    await unsuppress(email);
    console.info('[campaigns] resubscribed by request', { email, by: user.email });
    return res.status(200).json({ ok: true, email });
  }

  if (!id) {
    // GET /campaigns — the list, each with its headline numbers.
    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 100`;
      const campaigns = await Promise.all(rows.map(async (row) => ({
        ...serialiseCampaign(row),
        stats: await campaignStats(row.id).catch(() => null),
      })));
      const counts = await audienceSummary().catch(() => null);
      // The state of the user's last mailbox sweep rides along, so the Email
      // tab can show one running (or just-finished) without anyone having to
      // open the sweep window to find out.
      const { latestHarvestRun } = await import('./gmailHarvest.js');
      const harvest = await latestHarvestRun(user.email).catch(() => null);
      return res.status(200).json({ campaigns, counts, harvest });
    }
    // POST /campaigns — a new draft.
    if (req.method === 'POST') {
      const b = req.body || {};
      const newId = makeId('camp');
      const audience = AUDIENCES.includes(b.audience) ? b.audience : 'everyone';
      // A new campaign starts on the Squideo template rather than as an empty
      // box. A blank page is where most unsent drafts die, and the skeleton
      // also carries the things people forget — a merge tag and one clear
      // call to action.
      const body = b.bodyHtml === undefined ? DEFAULT_CAMPAIGN_BODY : (b.bodyHtml || '');
      await sql`
        INSERT INTO email_campaigns (id, name, audience, subject, preheader, body_html, reply_to, created_by)
        VALUES (${newId}, ${trimOrNull(b.name) || 'Untitled campaign'}, ${audience},
                ${b.subject || ''}, ${trimOrNull(b.preheader)}, ${body},
                ${trimOrNull(b.replyTo)}, ${user.email})`;
      const [row] = await sql`SELECT * FROM email_campaigns WHERE id = ${newId}`;
      return res.status(201).json(serialiseCampaign(row));
    }
    return res.status(405).end();
  }

  const [existing] = await sql`SELECT * FROM email_campaigns WHERE id = ${id}`;
  if (!existing) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = serialiseCampaign(existing);
  const editable = campaign.status === 'draft' || campaign.status === 'scheduled';

  // POST /campaigns/:id/image — an image for the body, posted as raw bytes with
  // an x-filename header (the same shape as deal-file uploads).
  //
  // Stored in the private blob store and served back through the public
  // /api/campaign-image route, because a recipient's mail client cannot
  // authenticate to fetch a private blob.
  if (action === 'image' && req.method === 'POST') {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(503).json({ error: 'File storage is not configured' });
    }
    const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!IMAGE_TYPES.has(mimeType)) {
      return res.status(415).json({ error: 'That file type will not display in an email — use a PNG, JPEG, GIF or WebP.' });
    }

    let buffer = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
    if (!buffer) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      buffer = Buffer.concat(chunks);
    }
    if (!buffer.length) return res.status(400).json({ error: 'Empty file' });
    // Mail clients are unforgiving about size, and every recipient downloads it.
    if (buffer.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({
        error: `That image is ${(buffer.length / 1024 / 1024).toFixed(1)} MB — keep it under ${MAX_IMAGE_BYTES / 1024 / 1024} MB so it loads before people give up.`,
      });
    }

    await ensureCampaignImages();
    const imageId = makeId('img').replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = String(req.headers['x-filename'] || 'image')
      .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const { put } = await import('@vercel/blob');
    const blob = await put(`campaign-images/${id}/${imageId}/${filename}`, buffer, {
      access: 'private', contentType: mimeType,
    });
    await sql`
      INSERT INTO email_campaign_images
        (id, campaign_id, filename, mime_type, size_bytes, blob_url, blob_pathname, uploaded_by)
      VALUES (${imageId}, ${id}, ${filename}, ${mimeType}, ${buffer.length},
              ${blob.url}, ${blob.pathname}, ${user.email})`;

    // Absolute, because it has to resolve from inside someone else's inbox.
    const base = (process.env.APP_URL || 'https://app.squideo.com').replace(/\/$/, '');
    return res.status(201).json({
      id: imageId,
      url: `${base}/api/campaign-image?i=${imageId}`,
      sizeBytes: buffer.length,
    });
  }

  // GET /campaigns/:id/exclusions — who's being left out of this one, and how
  // many people that leaves.
  if (action === 'exclusions' && req.method === 'GET') {
    const [excluded, people, openDeals] = await Promise.all([
      campaignExclusions(id),
      audienceRows(campaign.audience).catch(() => []),
      openDealEmails().catch(() => []),
    ]);
    const skip = new Set(excluded.map((e) => e.email));
    // Only the ones actually on THIS list matter — an open deal with a customer
    // is not on the non-customers list to begin with, and offering to exclude
    // someone who was never going to receive it is a number that means nothing.
    const onThisList = new Set(people.map((p) => p.email));
    const openOnList = openDeals.filter((d) => onThisList.has(d.email));
    return res.status(200).json({
      excluded,
      audienceTotal: people.length,
      willReceive: people.filter((p) => !skip.has(p.email)).length,
      openDeals: {
        total: openOnList.length,
        remaining: openOnList.filter((d) => !skip.has(d.email)).length,
        sample: openOnList.slice(0, 8),
      },
      byAge: audienceByAge(people, skip),
    });
  }

  // POST /campaigns/:id/exclusions — leave people out of this send.
  //
  // Not a suppression: that is the recipient's own decision, applies to
  // everything we ever send, and is not ours to make on their behalf. This is
  // the sender's, for this campaign only.
  if (action === 'exclusions' && req.method === 'POST') {
    if (!editable) {
      return res.status(409).json({ error: 'This campaign has already started — its recipients are fixed' });
    }
    // A named group resolves server-side, so "everyone with a live deal" is one
    // button rather than a search anybody could get wrong by hand.
    let emails;
    let reason = trimOrNull(req.body?.reason);
    if (req.body?.group === 'stale') {
      // Everyone we last heard from before a cutoff — the 2018 cohort and its
      // neighbours, which is where dead addresses concentrate.
      const before = trimOrNull(req.body?.before);
      if (!before) return res.status(400).json({ error: 'Before when?' });
      const stale = await staleAudience(campaign.audience, before);
      emails = stale.map((p) => p.email);
      const year = new Date(before).getUTCFullYear();
      reason = reason || `No contact since before ${year}`;
      if (!emails.length) {
        return res.status(200).json({ ok: true, added: 0, excluded: await campaignExclusions(id) });
      }
    } else if (req.body?.group === 'open_deals') {
      const open = await openDealEmails();
      emails = open.map((d) => d.email);
      reason = reason || 'Live deal in the pipeline';
      if (!emails.length) {
        return res.status(200).json({ ok: true, added: 0, excluded: await campaignExclusions(id) });
      }
    } else {
      emails = (Array.isArray(req.body?.emails) ? req.body.emails : [req.body?.email])
        .map((e) => String(e || '').trim().toLowerCase())
        .filter((e) => e.includes('@'));
      if (!emails.length) return res.status(400).json({ error: 'Which address?' });
    }
    const before = (await campaignExclusions(id)).length;
    await batchWrite(emails.map((email) => sql`
      INSERT INTO email_campaign_exclusions (campaign_id, email, reason, created_by)
      VALUES (${id}, ${email}, ${reason}, ${user.email})
      ON CONFLICT (campaign_id, email) DO NOTHING`));
    const excluded = await campaignExclusions(id);
    // How many were actually NEW — pressing the button twice should say
    // "already left out", not report the same people again.
    return res.status(200).json({ ok: true, added: excluded.length - before, excluded });
  }

  // DELETE /campaigns/:id/exclusions?email=… — put someone back in.
  if (action === 'exclusions' && req.method === 'DELETE') {
    const email = String(req.query.email || req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Which address?' });
    await sql`DELETE FROM email_campaign_exclusions WHERE campaign_id = ${id} AND email = ${email}`;
    return res.status(200).json({ ok: true, excluded: await campaignExclusions(id) });
  }

  // GET /campaigns/:id — everything the report page needs in one round trip.
  if (!action && req.method === 'GET') {
    const [stats, links, recipients, pace] = await Promise.all([
      campaignStats(id).catch(() => null),
      campaignLinks(id).catch(() => []),
      campaignRecipients(id).catch(() => []),
      // Only while it's actually running — for a finished campaign there is no
      // next batch, and the query would be work for nothing.
      campaign.status === 'sending' ? campaignPace(campaign).catch(() => null) : Promise.resolve(null),
    ]);
    // Whether bounces and complaints are actually reaching us. Without the
    // webhook those tiles read 0.0% whatever is really happening, which is
    // worse than showing nothing — it is the number someone would use to
    // decide it is safe to send faster.
    //
    // The boolean only; the secret itself never leaves the server.
    const bounceTracking = !!process.env.RESEND_WEBHOOK_SECRET;
    // Only worth computing once something has actually bounced — otherwise it's
    // a table of zeroes taking up the most valuable part of the report.
    const bounceAges = stats?.bounced > 0 ? await bounceByAge(id).catch(() => []) : [];
    return res.status(200).json({ campaign, stats, links, recipients, pace, bounceTracking, bounceAges });
  }

  // PATCH /campaigns/:id — edit a draft. A campaign that has started is frozen:
  // half its audience already has the old copy, so "editing" it would only make
  // the report meaningless.
  if (!action && (req.method === 'PATCH' || req.method === 'PUT')) {
    if (!editable) {
      return res.status(409).json({ error: 'This campaign has already been sent and can no longer be edited' });
    }
    const b = req.body || {};
    const audience = AUDIENCES.includes(b.audience) ? b.audience : campaign.audience;
    await sql`
      UPDATE email_campaigns
         SET name = ${trimOrNull(b.name) || campaign.name},
             audience = ${audience},
             subject = ${b.subject ?? campaign.subject},
             preheader = ${b.preheader === undefined ? campaign.preheader : trimOrNull(b.preheader)},
             body_html = ${b.bodyHtml ?? campaign.bodyHtml},
             reply_to = ${b.replyTo === undefined ? campaign.replyTo : trimOrNull(b.replyTo)},
             hourly_cap = ${b.hourlyCap === undefined ? campaign.hourlyCap : (Number(b.hourlyCap) || null)},
             daily_cap = ${b.dailyCap === undefined ? campaign.dailyCap : (Number(b.dailyCap) || null)},
             updated_at = NOW()
       WHERE id = ${id}`;
    const [row] = await sql`SELECT * FROM email_campaigns WHERE id = ${id}`;
    return res.status(200).json(serialiseCampaign(row));
  }

  if (!action && req.method === 'DELETE') {
    if (campaign.status === 'sending') {
      return res.status(409).json({ error: 'This campaign is sending — pause it first' });
    }
    await sql`DELETE FROM email_campaigns WHERE id = ${id}`;
    return res.status(204).end();
  }

  // POST /campaigns/:id/test — one copy to whoever asked for it, rendered
  // through exactly the same path as the real thing (merge tags, wrapper,
  // footer), so what lands in the inbox is what the list would get.
  if (action === 'test' && req.method === 'POST') {
    const to = trimOrNull(req.body?.to) || user.email;
    const sample = {
      email: to,
      name: trimOrNull(req.body?.name) || user.name || 'Sam Taylor',
      companyName: trimOrNull(req.body?.companyName) || 'Acme Ltd',
    };
    const built = renderForRecipient(campaign, sample, null, { unsubscribeList: 'campaign-test' });
    try {
      await sendMail({
        to,
        subject: `[TEST] ${built.subject || campaign.name}`,
        html: built.html,
        text: built.text,
        // Transactional scope on purpose: a test goes to us, must not be
        // stopped by the suppression list, and must never be counted as part
        // of the campaign's results.
        scope: 'transactional',
        replyTo: campaign.replyTo || null,
        throwOnError: true,
      });
    } catch (err) {
      return res.status(502).json({ error: 'Test send failed: ' + (err.message || 'unknown error') });
    }
    return res.status(200).json({ ok: true, to });
  }

  // POST /campaigns/:id/preview — the rendered html for the composer's preview
  // pane. No send, no tracking row; takes the unsaved draft in the body so the
  // preview is of what's on screen, not of what was last saved.
  if (action === 'preview' && req.method === 'POST') {
    const b = req.body || {};
    const draft = {
      ...campaign,
      subject: b.subject ?? campaign.subject,
      preheader: b.preheader ?? campaign.preheader,
      bodyHtml: b.bodyHtml ?? campaign.bodyHtml,
    };
    const built = renderForRecipient(draft, {
      email: 'sam@acme.com', name: 'Sam Taylor', companyName: 'Acme Ltd',
    }, null);
    return res.status(200).json({ subject: built.subject, html: built.html });
  }

  // POST /campaigns/:id/send — snapshot the list and start the queue, or set a
  // time for it to start itself.
  if (action === 'send' && req.method === 'POST') {
    if (!editable) return res.status(409).json({ error: 'This campaign has already been sent' });
    if (!String(campaign.subject || '').trim()) {
      return res.status(400).json({ error: 'Add a subject line first' });
    }
    if (!String(campaign.bodyHtml || '').replace(/<[^>]*>/g, '').trim()) {
      return res.status(400).json({ error: 'The email is empty' });
    }

    const scheduledAt = trimOrNull(req.body?.scheduledAt);
    if (scheduledAt) {
      const when = new Date(scheduledAt);
      if (Number.isNaN(when.getTime())) {
        return res.status(400).json({ error: 'That send time is not a valid date' });
      }
      await sql`
        UPDATE email_campaigns
           SET status = 'scheduled', scheduled_at = ${when.toISOString()}, updated_at = NOW()
         WHERE id = ${id}`;
      const [row] = await sql`SELECT * FROM email_campaigns WHERE id = ${id}`;
      return res.status(200).json({ ok: true, scheduled: true, campaign: serialiseCampaign(row) });
    }

    const total = await snapshotAudience(campaign);
    if (!total) return res.status(400).json({ error: 'Nobody is on that list right now' });
    await sql`
      UPDATE email_campaigns
         SET status = 'sending', started_at = COALESCE(started_at, NOW()),
             scheduled_at = NULL, updated_at = NOW()
       WHERE id = ${id}`;
    // One batch inline so the sender watches it start moving; the cron takes it
    // from there. Deliberately not drained to completion — the request budget
    // is 60 seconds and the queue is durable.
    const first = await drainCampaigns({ batches: 1, campaignId: id }).catch((err) => {
      console.error('[campaigns] inline drain failed', err.message);
      return null;
    });
    return res.status(200).json({ ok: true, queued: total, firstBatch: first?.sent || 0 });
  }

  // Pause / resume / cancel. Pause leaves the queue exactly as it is, so
  // resuming picks up at the next unsent person rather than starting again.
  if (action === 'pause' && req.method === 'POST') {
    await sql`UPDATE email_campaigns SET status = 'paused', updated_at = NOW()
               WHERE id = ${id} AND status IN ('sending', 'scheduled')`;
    // Anything mid-claim goes back on the queue.
    await sql`UPDATE email_campaign_recipients SET status = 'queued'
               WHERE campaign_id = ${id} AND status = 'sending'`;
    const [row] = await sql`SELECT * FROM email_campaigns WHERE id = ${id}`;
    return res.status(200).json(serialiseCampaign(row));
  }
  if (action === 'resume' && req.method === 'POST') {
    await sql`UPDATE email_campaigns SET status = 'sending', updated_at = NOW()
               WHERE id = ${id} AND status = 'paused'`;
    await drainCampaigns({ batches: 1, campaignId: id }).catch(() => {});
    const [row] = await sql`SELECT * FROM email_campaigns WHERE id = ${id}`;
    return res.status(200).json(serialiseCampaign(row));
  }
  if (action === 'cancel' && req.method === 'POST') {
    await sql`UPDATE email_campaigns
                 SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
               WHERE id = ${id} AND status IN ('sending', 'paused', 'scheduled')`;
    await sql`UPDATE email_campaign_recipients
                 SET status = 'skipped', error = 'Campaign cancelled'
               WHERE campaign_id = ${id} AND status IN ('queued', 'sending')`;
    const [row] = await sql`SELECT * FROM email_campaigns WHERE id = ${id}`;
    return res.status(200).json(serialiseCampaign(row));
  }

  // POST /campaigns/:id/speed — change how fast a campaign sends, including
  // one that is already running.
  //
  // Safe to do mid-flight, and that is the point: the caps are read fresh from
  // this row at the start of every batch, so a change lands on the next cron
  // run without restarting anything, and a batch already in the air is
  // unaffected. Nothing here touches the queue or a recipient.
  //
  // Raising the cap mid-hour does NOT clear the window — the sends already in
  // it still count. Going from 150 to 500 an hour with 150 already sent frees
  // 350 immediately, which is the behaviour you want: it resumes at once but
  // still honours the hour it is in.
  if (action === 'speed' && req.method === 'POST') {
    if (['sent', 'cancelled'].includes(campaign.status)) {
      return res.status(409).json({ error: 'This campaign has finished' });
    }
    const cap = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const hourlyCap = cap(req.body?.hourlyCap);
    const dailyCap = cap(req.body?.dailyCap);
    await sql`
      UPDATE email_campaigns
         SET hourly_cap = ${hourlyCap}, daily_cap = ${dailyCap}, updated_at = NOW()
       WHERE id = ${id}`;
    const [row] = await sql`SELECT * FROM email_campaigns WHERE id = ${id}`;
    const updated = serialiseCampaign(row);
    console.info('[campaigns] send speed changed', {
      id, by: user.email, hourlyCap, dailyCap, status: campaign.status,
    });
    return res.status(200).json({
      campaign: updated,
      pace: updated.status === 'sending' ? await campaignPace(updated).catch(() => null) : null,
    });
  }

  // POST /campaigns/:id/reopen — put a cancelled campaign back to a draft.
  //
  // Only when nothing actually went out. Cancelling before the first batch is
  // almost always "wait, I need to change something", and leaving that as a
  // dead end forces people to retype the whole email. But once even one person
  // has it, editing is no longer honest: two different versions of the same
  // campaign would exist under one report, and re-sending would post it to
  // those people twice. That case duplicates instead.
  if (action === 'reopen' && req.method === 'POST') {
    if (campaign.status !== 'cancelled' && campaign.status !== 'paused') {
      return res.status(409).json({ error: 'Only a cancelled or paused campaign can be reopened' });
    }
    const [{ n: alreadySent }] = await sql`
      SELECT COUNT(*)::int AS n FROM email_campaign_recipients
       WHERE campaign_id = ${id} AND status = 'sent'`;
    if (alreadySent > 0) {
      return res.status(409).json({
        error: `${alreadySent} ${alreadySent === 1 ? 'person has' : 'people have'} already received this one — duplicate it instead, and they'll be left out of the copy.`,
        code: 'ALREADY_SENT',
        alreadySent,
      });
    }
    // The recipient snapshot goes too: the list may have changed since, and a
    // reopened draft should send to the list as it is when it finally goes.
    await sql`DELETE FROM email_campaign_recipients WHERE campaign_id = ${id}`;
    await sql`
      UPDATE email_campaigns
         SET status = 'draft', started_at = NULL, completed_at = NULL,
             scheduled_at = NULL, updated_at = NOW()
       WHERE id = ${id}`;
    const [row] = await sql`SELECT * FROM email_campaigns WHERE id = ${id}`;
    return res.status(200).json(serialiseCampaign(row));
  }

  // POST /campaigns/:id/duplicate — a fresh draft with the same content.
  //
  // The way to change a campaign that has already reached somebody. Anyone who
  // received the original is carried over as an exclusion by default, because
  // the one thing worse than a cancelled send is the same person getting it
  // twice.
  if (action === 'duplicate' && req.method === 'POST') {
    const newId = makeId('camp');
    const suffix = campaign.name.match(/\(copy( \d+)?\)$/i) ? '' : ' (copy)';
    await sql`
      INSERT INTO email_campaigns
        (id, name, audience, subject, preheader, body_html, reply_to,
         hourly_cap, daily_cap, created_by)
      VALUES (${newId}, ${campaign.name + suffix}, ${campaign.audience}, ${campaign.subject},
              ${campaign.preheader || null}, ${campaign.bodyHtml}, ${campaign.replyTo},
              ${campaign.hourlyCap}, ${campaign.dailyCap}, ${user.email})`;

    // Carry the original's own exclusions — they were decisions about these
    // people, not about that send.
    const previous = await campaignExclusions(id);
    const carried = previous.map((e) => e.email);

    const excludeSent = req.body?.excludeAlreadySent !== false;
    const sentTo = excludeSent
      ? (await sql`SELECT email FROM email_campaign_recipients
                    WHERE campaign_id = ${id} AND status = 'sent'`).map((r) => r.email)
      : [];

    const all = [...new Set([...carried, ...sentTo])];
    if (all.length) {
      await batchWrite(all.map((email) => sql`
        INSERT INTO email_campaign_exclusions (campaign_id, email, reason, created_by)
        VALUES (${newId}, ${email},
                ${sentTo.includes(email) ? 'Already received the original' : 'Excluded from the original'},
                ${user.email})
        ON CONFLICT (campaign_id, email) DO NOTHING`));
    }
    const [row] = await sql`SELECT * FROM email_campaigns WHERE id = ${newId}`;
    return res.status(201).json({
      campaign: serialiseCampaign(row),
      excluded: all.length,
      alreadySent: sentTo.length,
    });
  }

  // GET /campaigns/:id/recipients?filter=opened|clicked|unopened|failed
  if (action === 'recipients' && req.method === 'GET') {
    const recipients = await campaignRecipients(id, { filter: req.query.filter || 'all' });
    return res.status(200).json({ recipients });
  }

  return res.status(404).json({ error: 'Unknown campaign action' });
}
