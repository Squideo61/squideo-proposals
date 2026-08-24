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
  renderMergeTags, wrapCampaignHtml, htmlToText, stripUnsafeHtml,
} from './campaignHtml.js';

export const AUDIENCES = ['everyone', 'customers', 'non_customers'];
export const AUDIENCE_LABELS = {
  everyone: 'Everyone',
  customers: 'Customers',
  non_customers: 'Non-customers',
};

// What makes someone a customer: a deal that reached signed, paid or long-term.
// Anything earlier is a prospect, however warm it feels.
const WON_STAGES = ['signed', 'paid', 'long_term'];

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
  if (row.unsubscribed) {
    const bounced = row.suppression_scope === 'all'
      || (row.suppression_reason && row.suppression_reason !== 'unsubscribe');
    return bounced ? 'bounced' : 'unsubscribed';
  }
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
export async function audienceRows(audience = 'everyone', { includeUnsubscribed = false } = {}) {
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
             (cc.id IS NOT NULL) AS is_customer, 1 AS pref
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
             2 AS pref
        FROM course_signups s
       WHERE s.email IS NOT NULL AND POSITION('@' IN s.email) > 1
    ),
    dedup AS (
      -- One row per address. A customer row beats a non-customer one and a
      -- contact beats a signup, so nobody is counted twice or lands in both
      -- lists.
      SELECT DISTINCT ON (email) email, name, company_name, contact_id, company_id, is_customer
        FROM people
       ORDER BY email, is_customer DESC, pref ASC
    )
    SELECT d.email, d.name, COALESCE(co.name, d.company_name) AS company_name,
           d.contact_id, d.company_id, d.is_customer,
           -- The explicit tick, where there is one. Only the lead-magnet forms
           -- ask for it, so most contacts are on the soft opt-in basis instead
           -- — which the UI says out loud rather than implying consent we were
           -- never given.
           COALESCE(cs.marketing_consent, FALSE) AS opted_in,
           cs.consent_at, cs.consent_source, cs.consent_text,
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
      LEFT JOIN email_suppressions s ON s.email = d.email
     WHERE d.email NOT ILIKE '%@squideo.co.uk'
       AND d.email NOT ILIKE '%@squideo.com'
     ORDER BY d.is_customer DESC, d.email
  `;
  const labels = await suppressionSourceLabels();
  const all = rows.map((r) => ({
    email: r.email,
    name: r.name || null,
    companyName: r.company_name || null,
    contactId: r.contact_id || null,
    companyId: r.company_id || null,
    isCustomer: !!r.is_customer,
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
  const byAudience = audience === 'customers'
    ? all.filter((r) => r.isCustomer)
    : (audience === 'non_customers' ? all.filter((r) => !r.isCustomer) : all);
  return includeUnsubscribed
    ? byAudience
    : byAudience.filter((r) => r.status !== 'unsubscribed' && r.status !== 'bounced');
}

// Counts for the three list cards, plus how many people the suppression list is
// holding back. That last number is worth showing — it's the one that explains
// why "Everyone" is smaller than the contacts page.
export async function audienceSummary() {
  const everyone = await audienceRows('everyone', { includeUnsubscribed: true });
  const mailable = everyone.filter((r) => r.status !== 'unsubscribed' && r.status !== 'bounced');
  const customers = mailable.filter((r) => r.isCustomer).length;
  // Counted off the same rows as the lists themselves, so "off the list" and
  // "on the list" always add up to the people we hold. A separate COUNT(*) on
  // the suppression table wouldn't: it also holds addresses we've never had a
  // contact record for.
  const unsubscribed = everyone.filter((r) => r.status === 'unsubscribed').length;
  const bounced = everyone.filter((r) => r.status === 'bounced').length;
  return {
    everyone: mailable.length,
    customers,
    non_customers: mailable.length - customers,
    optedIn: mailable.filter((r) => r.optedIn).length,
    unsubscribed,
    bounced,
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
  const people = await audienceRows(campaign.audience);
  if (people.length) {
    await batchWrite(people.map((p) => sql`
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

// Send one batch for one campaign. Returns how many recipients it handled — 0
// means the queue is empty and the campaign can be closed off.
//
// The claim is a single UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED), so
// two overlapping runs can never claim the same recipient. That property is the
// only thing standing between a slow send and someone receiving the campaign
// twice, which is why it's one statement rather than a select then an update.
async function sendBatch(campaign) {
  const claimed = await sql`
    UPDATE email_campaign_recipients r
       SET status = 'sending'
      FROM (
        SELECT id FROM email_campaign_recipients
         WHERE campaign_id = ${campaign.id} AND status = 'queued'
         ORDER BY id
         LIMIT ${BATCH_LIMIT}
         FOR UPDATE SKIP LOCKED
      ) c
     WHERE r.id = c.id
    RETURNING r.id, r.email, r.name, r.company_name
  `;
  if (!claimed.length) return 0;

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

  await batchWrite(recipients.map((r, i) => {
    const result = results[i] || { ok: false, error: 'No result' };
    const status = result.ok ? 'sent' : (result.suppressed ? 'skipped' : 'failed');
    const trackingId = trackingByToken.get(tokens[i]) || null;
    return sql`
      UPDATE email_campaign_recipients
         SET status = ${status},
             tracking_id = ${trackingId},
             provider_id = ${result.id || null},
             error = ${result.ok ? null : (result.error || 'Send failed')},
             sent_at = ${result.ok ? new Date().toISOString() : null}
       WHERE id = ${r.id}
    `;
  }));
  return recipients.length;
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
    for (let b = 0; b < batches; b++) {
      let n = 0;
      try { n = await sendBatch(campaign); }
      catch (err) {
        console.error('[campaigns] batch failed', { id: campaign.id, err: err.message });
        break;
      }
      if (!n) break;
      sent += n;
    }
    const [remaining] = await sql`
      SELECT COUNT(*)::int AS n FROM email_campaign_recipients
       WHERE campaign_id = ${campaign.id} AND status IN ('queued', 'sending')`;
    if (!remaining?.n) {
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
           COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
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
    // Always fetched WITH the opt-outs, whatever is being shown: the tab counts
    // have to include the people who aren't on the list, or "Unsubscribed 0"
    // would read as nobody having unsubscribed.
    const [counts, rows] = await Promise.all([
      audienceSummary(),
      audienceRows(audience, { includeUnsubscribed: true }),
    ]);
    const mailable = rows.filter((r) => r.status !== 'unsubscribed' && r.status !== 'bounced');
    const shown = status === 'all' ? rows
      : status === 'opted_in' ? mailable.filter((r) => r.optedIn)
      : status === 'soft' ? mailable.filter((r) => !r.optedIn)
      : status === 'unsubscribed' ? rows.filter((r) => r.status === 'unsubscribed')
      : status === 'bounced' ? rows.filter((r) => r.status === 'bounced')
      : mailable;
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
      },
      shown: shown.length,
      sample: shown.slice(0, 300),
    });
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
      return res.status(200).json({ campaigns, counts });
    }
    // POST /campaigns — a new draft.
    if (req.method === 'POST') {
      const b = req.body || {};
      const newId = makeId('camp');
      const audience = AUDIENCES.includes(b.audience) ? b.audience : 'everyone';
      await sql`
        INSERT INTO email_campaigns (id, name, audience, subject, preheader, body_html, reply_to, created_by)
        VALUES (${newId}, ${trimOrNull(b.name) || 'Untitled campaign'}, ${audience},
                ${b.subject || ''}, ${trimOrNull(b.preheader)}, ${b.bodyHtml || ''},
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

  // GET /campaigns/:id — everything the report page needs in one round trip.
  if (!action && req.method === 'GET') {
    const [stats, links, recipients] = await Promise.all([
      campaignStats(id).catch(() => null),
      campaignLinks(id).catch(() => []),
      campaignRecipients(id).catch(() => []),
    ]);
    return res.status(200).json({ campaign, stats, links, recipients });
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

  // GET /campaigns/:id/recipients?filter=opened|clicked|unopened|failed
  if (action === 'recipients' && req.method === 'GET') {
    const recipients = await campaignRecipients(id, { filter: req.query.filter || 'all' });
    return res.status(200).json({ recipients });
  }

  return res.status(404).json({ error: 'Unknown campaign action' });
}
