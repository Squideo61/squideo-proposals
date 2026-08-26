// Marketing analytics — the WhatConverts-style lead-attribution reports.
// Joins web-form leads (quote_requests, carrying first-touch attribution) to the
// deals they became (quote_requests.deal_id) and to Google Ads spend
// (ad_spend_daily) to answer: which ads/keywords drive leads, and how much
// revenue + ROAS they generate.
//
// Revenue is taken from annotateDeals().effectiveValue (signed proposal total >
// manual value > latest proposal) so the figures reconcile exactly with the
// sales pipeline. Spend/CPL/ROAS only light up once Google Ads is configured.
import sql from '../db.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { APP_URL } from '../email.js';
import { annotateDeals } from './deals.js';
import { ensureLeadAttribution } from '../leadAttribution.js';
import { adsConfigured, ensureAdSpend, runAdSpendSync } from './googleAds.js';
import { gscConfigured, runGscSync, runGscBackfill, searchReport } from './googleSearch.js';
import { ga4Configured, runGa4Sync, trafficReport } from './googleAnalytics.js';
import { getSyncStatus, recordSyncStatus } from './marketingSyncStatus.js';
import { isSignedSale } from './signedSale.js';
import { briefsReport, briefDetail, setBriefExcluded } from './briefAnalytics.js';

// A "sale" uses the shared signed-sale definition (./signedSale.js): an actual
// signature or a signed/paid stage, a real value, and not a historical import —
// so Marketing and Sales Insights agree. A deal merely parked in long_term with
// no signature does NOT count.
const round2 = (n) => Number((Number(n) || 0).toFixed(2));

// Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD off req.url (the dispatcher preserves the
// original query string when it rewrites the path). `to` is inclusive of the
// whole day → we return an exclusive upper bound. Default: last 90 days.
function parseRange(req) {
  let from = null, to = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    from = u.searchParams.get('from');
    to = u.searchParams.get('to');
  } catch { /* ignore */ }
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const now = new Date();
  const toDate = isDate(to) ? new Date(to + 'T00:00:00Z') : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toExcl = new Date(toDate.getTime() + 24 * 60 * 60 * 1000); // include the whole `to` day
  const fromDate = isDate(from) ? new Date(from + 'T00:00:00Z') : new Date(toExcl.getTime() - 90 * 24 * 60 * 60 * 1000);
  const dateStr = (d) => d.toISOString().slice(0, 10);
  return { fromDate, toExcl, fromStr: dateStr(fromDate), toStr: dateStr(toExcl) };
}

// "Marketing data starts from" cutoff — leads before it (incomplete first-touch
// attribution from the early tracking rollout) are excluded from the lead-based
// reports so they don't skew channel/CPL/ROAS. Stored on the settings row;
// configurable in the Marketing UI. NULL means "not configured yet", so we
// one-time default it to 2026-06-13 (the first day with complete attribution).
let marketingCutoffReady = null;
function ensureMarketingCutoff() {
  if (marketingCutoffReady) return marketingCutoffReady;
  marketingCutoffReady = (async () => {
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS marketing_leads_from DATE`;
    await sql`UPDATE settings SET marketing_leads_from = '2026-06-13' WHERE id = 1 AND marketing_leads_from IS NULL`;
  })().catch((err) => { marketingCutoffReady = null; throw err; });
  return marketingCutoffReady;
}
async function getMarketingCutoff() {
  try {
    await ensureMarketingCutoff();
    const [row] = await sql`SELECT marketing_leads_from FROM settings WHERE id = 1`;
    return row?.marketing_leads_from ? new Date(row.marketing_leads_from).toISOString().slice(0, 10) : null;
  } catch { return null; }
}

// Counting basis — which date puts a number in the selected period.
//   'event' (default): every funnel stage is counted in the period it actually
//     happened, so a deal signed in August lands in August even though its lead
//     came in back in July. Answers "what did we do this month?".
//   'lead' (cohort): everything a lead ever produced is credited to the period
//     the lead arrived in. Answers "what were this month's leads worth?" and is
//     the only basis that gives a true per-cohort ROAS.
function parseBasis(req) {
  try {
    const u = new URL(req.url, 'http://localhost');
    return u.searchParams.get('basis') === 'lead' ? 'lead' : 'event';
  } catch { return 'event'; }
}

// parseRange, but floored at the marketing cutoff so the lead-based reports never
// reach back before it (whatever range the user picked).
async function leadRange(req) {
  const r = parseRange(req);
  const cutoff = await getMarketingCutoff();
  if (cutoff) {
    const c = new Date(cutoff + 'T00:00:00Z');
    if (c > r.fromDate) return { ...r, fromDate: c, fromStr: cutoff };
  }
  return r;
}

// Per-deal info for the lead reports, via annotateDeals (so values match the
// pipeline) plus the signature signed_at (the sale date). Returns
// Map<dealId, { value, stage, proposalValue, isSale, saleAt, proposalAt }>:
//   value         — effectiveValue (signed > latest proposal > manual)
//   proposalValue — effectiveValue when a proposal exists (else null)
//   isSale        — genuine signed sale per ./signedSale.js (signature or a
//                   signed/paid stage, real value, not an import; bare long_term
//                   with no signature does NOT count)
//   saleAt        — earliest signature signed_at (fallback: stage_changed_at)
//   proposalAt    — earliest proposal created_at (when the proposal went out)
async function dealInfoMap(dealIds) {
  const map = new Map();
  const ids = [...new Set(dealIds.filter(Boolean))];
  if (!ids.length) return map;
  const rows = await sql`SELECT * FROM deals WHERE id = ANY(${ids})`;
  const annotated = await annotateDeals(rows);
  const stageInfo = new Map(rows.map((r) => [r.id, { stage: r.stage || null, stageChangedAt: r.stage_changed_at || null }]));

  // Sale date = earliest signed signature across the deal's proposals.
  let signedMap = new Map();
  try {
    const sig = await sql`
      SELECT p.deal_id AS did, MIN(s.signed_at) AS signed_at
        FROM signatures s JOIN proposals p ON p.id = s.proposal_id
       WHERE p.deal_id = ANY(${ids}) AND s.signed_at IS NOT NULL
       GROUP BY p.deal_id`;
    signedMap = new Map(sig.map((r) => [r.did, r.signed_at]));
  } catch { /* signatures table not present */ }

  // Proposal date = earliest proposal on the deal, i.e. when we first put a
  // price in front of them. Used by the by-event counting basis.
  let proposalAtMap = new Map();
  try {
    const props = await sql`
      SELECT deal_id AS did, MIN(created_at) AS created_at
        FROM proposals WHERE deal_id = ANY(${ids}) GROUP BY deal_id`;
    proposalAtMap = new Map(props.map((r) => [r.did, r.created_at]));
  } catch { /* proposals table not present */ }

  // Stage-change history — lets the shared predicate credit a deal that reached
  // signed/paid even if it has since moved on (e.g. to long_term).
  const eventsByDeal = new Map();
  try {
    const evs = await sql`
      SELECT deal_id, payload, occurred_at
        FROM deal_events
       WHERE event_type = 'stage_change' AND deal_id = ANY(${ids})
       ORDER BY deal_id, occurred_at ASC`;
    for (const e of evs) {
      if (!eventsByDeal.has(e.deal_id)) eventsByDeal.set(e.deal_id, []);
      eventsByDeal.get(e.deal_id).push({ to: e.payload?.to, at: e.occurred_at });
    }
  } catch { /* no deal_events */ }

  for (const d of annotated) {
    const si = stageInfo.get(d.id) || {};
    const signedAt = signedMap.get(d.id) || null;
    const events = eventsByDeal.get(d.id) || [];
    const value = Number(d.effectiveValue) || 0;
    const isSale = isSignedSale({ id: d.id, stage: si.stage, hasSignature: !!signedAt, value, events });
    const hasProposal = d.valueSource === 'proposal' || d.valueSource === 'signed';
    map.set(d.id, {
      value,
      stage: si.stage,
      proposalValue: hasProposal ? value : null,
      isSale,
      saleAt: signedAt || (isSale ? (si.stageChangedAt || null) : null),
      proposalAt: proposalAtMap.get(d.id) || null,
    });
  }
  return map;
}

// Spend buckets for the range, de-duplicated: campaign-level rows
// (ad_group_id='' AND criterion_id='') are the authoritative per-campaign totals
// — including non-keyword spend — so we never sum them together with the
// keyword-level rows. Keyword spend comes only from keyword-level rows.
async function spendBuckets(fromStr, toStr) {
  const byCampaign = new Map(); // campaign_id -> { cost, clicks, name }
  const byKeyword = new Map();  // lower(keyword) -> cost
  let total = 0;
  if (!adsConfigured()) return { byCampaign, byKeyword, total };
  try {
    await ensureAdSpend();
    const campRows = await sql`
      SELECT campaign_id, MAX(campaign_name) AS campaign_name,
             SUM(cost_micros)::numeric AS cost_micros, SUM(clicks)::numeric AS clicks
        FROM ad_spend_daily
       WHERE day >= ${fromStr}::date AND day < ${toStr}::date
         AND ad_group_id = '' AND criterion_id = ''
       GROUP BY campaign_id`;
    for (const r of campRows) {
      const cost = (Number(r.cost_micros) || 0) / 1e6;
      byCampaign.set(String(r.campaign_id), { cost, clicks: Number(r.clicks) || 0, name: r.campaign_name || null });
      total += cost;
    }
    const kwRows = await sql`
      SELECT LOWER(keyword_text) AS kw, SUM(cost_micros)::numeric AS cost_micros
        FROM ad_spend_daily
       WHERE day >= ${fromStr}::date AND day < ${toStr}::date
         AND criterion_id <> '' AND keyword_text IS NOT NULL
       GROUP BY LOWER(keyword_text)`;
    for (const r of kwRows) byKeyword.set(r.kw, (Number(r.cost_micros) || 0) / 1e6);
  } catch (err) {
    console.warn('[analytics spendBuckets]', err?.message);
  }
  return { byCampaign, byKeyword, total };
}

// Friendly campaign id -> name (synced from Google Ads). Robust to a missing
// table (returns an empty map). Lets the reports show campaign names rather than
// the numeric ids the ValueTrack {campaignid} captures.
async function campaignNameMap() {
  const map = new Map();
  try {
    const rows = await sql`SELECT campaign_id, name FROM ad_campaigns WHERE name IS NOT NULL`;
    for (const r of rows) map.set(String(r.campaign_id), r.name);
  } catch { /* table not present yet */ }
  return map;
}

// A campaign value that isn't just the numeric id (utm_campaign is set to
// {campaignid} by our tracking suffix, so it's usually numeric).
const nonNumeric = (v) => (v && !/^\d+$/.test(v) ? v : null);

// The stored landing URL is the full first-touch address, query string and all
// (gclid, utm_*, ...), so grouping on it raw would split a single page into
// dozens of one-lead rows. Key on host + path instead, and hand back a clean
// URL for the report row to link to. The key is lowercased for grouping; the
// label keeps the URL as it was in case a path is case-sensitive.
function landingPage(url) {
  if (!url) return null;
  let host, path;
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    path = u.pathname || '/';
  } catch {
    return null;
  }
  // A trailing slash is the same page to a web server but a different string
  // to us, so /pricing/ and /pricing must not become two rows.
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const shown = host + path;
  return { key: shown.toLowerCase(), label: shown, url: 'https://' + shown };
}

// GET /api/crm/analytics/leads — one row per lead with attribution + the deal it
// became + the revenue it generated.
async function leadsLog(req) {
  const { fromDate, toExcl, fromStr, toStr } = await leadRange(req);
  const rows = await sql`
    SELECT qr.id, qr.created_at, qr.name, qr.email, qr.company,
           qr.phone, qr.country_code, qr.country_name,
           qr.project_details, qr.timeline, qr.budget, qr.opt_in, qr.source_url,
           qr.reviewed_at,
           qr.attr_channel, qr.attr_source, qr.attr_medium, qr.attr_campaign,
           qr.attr_campaign_id, qr.attr_keyword, qr.attr_term, qr.attr_landing_url,
           qr.status, qr.deal_id,
           d.stage AS deal_stage, d.title AS deal_title, d.company_id
      FROM quote_requests qr
      LEFT JOIN deals d ON d.id = qr.deal_id
     WHERE qr.created_at >= ${fromDate} AND qr.created_at < ${toExcl}
     ORDER BY qr.created_at DESC`;
  const info = await dealInfoMap(rows.map((r) => r.deal_id));
  const names = await campaignNameMap();
  // Attach uploaded files so the Marketing lead panel can list them. Rows that
  // were disqualified/spam have had their files purged, so this comes back empty
  // for those — expected.
  const ids = rows.map((r) => r.id);
  const fileRows = ids.length
    ? await sql`
        SELECT quote_request_id, filename, mime_type, size_bytes
        FROM quote_request_files
        WHERE quote_request_id = ANY(${ids})
        ORDER BY created_at ASC`
    : [];
  const filesByReq = new Map();
  for (const f of fileRows) {
    if (!filesByReq.has(f.quote_request_id)) filesByReq.set(f.quote_request_id, []);
    filesByReq.get(f.quote_request_id).push({ filename: f.filename, mimeType: f.mime_type, sizeBytes: f.size_bytes });
  }
  const leads = rows.map((r) => {
    const dv = r.deal_id ? info.get(r.deal_id) : null;
    const isSale = !!(dv && dv.isSale);
    return {
      id: r.id,
      createdAt: r.created_at,
      name: r.name || null,
      email: r.email || null,
      company: r.company || null,
      phone: r.phone ? `${r.country_code || ''} ${r.phone}`.trim() : null,
      country: r.country_name || null,
      projectDetails: r.project_details || null,
      timeline: r.timeline || null,
      budget: r.budget || null,
      optIn: r.opt_in === true,
      sourceUrl: r.source_url || null,
      reviewedAt: r.reviewed_at || null,
      channel: r.attr_channel || null,
      source: r.attr_source || null,
      medium: r.attr_medium || null,
      campaign: (r.attr_campaign_id && names.get(r.attr_campaign_id)) || nonNumeric(r.attr_campaign) || r.attr_campaign || null,
      campaignId: r.attr_campaign_id || null,
      keyword: r.attr_keyword || r.attr_term || null,
      landingUrl: r.attr_landing_url || null,
      status: r.status || 'new',
      dealId: r.deal_id || null,
      dealTitle: r.deal_title || null,
      dealStage: (dv && dv.stage) || r.deal_stage || null,
      proposalValue: dv && dv.proposalValue != null ? round2(dv.proposalValue) : null,
      companyId: r.company_id || null,
      won: isSale,
      saleAt: (dv && dv.saleAt) || null,
      revenue: isSale && dv ? round2(dv.value) : 0,
      files: filesByReq.get(r.id) || [],
    };
  });
  return { from: fromStr, to: toStr, count: leads.length, leads };
}

// GET /api/crm/analytics/reports/:groupBy — aggregated per source/medium/
// campaign/keyword/channel. ?basis=event (default) counts each milestone in the
// period it happened; ?basis=lead is the cohort view (see parseBasis).
async function reports(req, groupBy) {
  const dim = ['source', 'medium', 'campaign', 'keyword', 'channel', 'page'].includes(groupBy) ? groupBy : 'campaign';
  const { fromDate, toExcl, fromStr, toStr } = await leadRange(req);
  const basis = parseBasis(req);

  // On the event basis a sale can belong to this period while its lead arrived
  // long before it, so we have to scan back past `from` — as far as the
  // marketing cutoff (leads before that have incomplete attribution and are
  // excluded from these reports by design). Attribution still comes from the
  // originating lead, so the sale lands on the right campaign/keyword.
  const cutoff = basis === 'event' ? await getMarketingCutoff() : null;
  const scanFrom = cutoff ? new Date(cutoff + 'T00:00:00Z') : fromDate;

  const rows = await sql`
    SELECT qr.id, qr.status, qr.deal_id, qr.created_at, qr.reviewed_at,
           qr.attr_channel, qr.attr_source, qr.attr_medium,
           qr.attr_campaign, qr.attr_campaign_id, qr.attr_keyword, qr.attr_term,
           qr.attr_landing_url
      FROM quote_requests qr
     WHERE qr.created_at >= ${scanFrom} AND qr.created_at < ${toExcl}`;
  const info = await dealInfoMap(rows.map((r) => r.deal_id));
  const { byCampaign, byKeyword, total: totalSpend } = await spendBuckets(fromStr, toStr);
  const names = dim === 'campaign' ? await campaignNameMap() : null;

  // Bucket leads by the chosen dimension. For campaign we key by campaign id but
  // label it with the friendly Google Ads name (falling back to the id).
  const groups = new Map();
  const keyFor = (r) => {
    if (dim === 'source') return { key: r.attr_source || '(none)', label: r.attr_source || '(none)' };
    if (dim === 'medium') return { key: r.attr_medium || '(none)', label: r.attr_medium || '(none)' };
    if (dim === 'channel') return { key: r.attr_channel || 'direct', label: r.attr_channel || 'direct' };
    if (dim === 'keyword') { const k = r.attr_keyword || r.attr_term; return { key: (k || '(none)').toLowerCase(), label: k || '(none)' }; }
    // Leads with no landing URL — added by hand, backfilled from email, or from
    // before the tracker went live — collect in one (none) row rather than being
    // dropped, so the Leads column still sums to the same total as it does under
    // every other grouping.
    if (dim === 'page') return landingPage(r.attr_landing_url) || { key: '(none)', label: '(none)' };
    // campaign — prefer the friendly name, then a non-numeric utm_campaign, then the id.
    const id = r.attr_campaign_id || null;
    const label = (id && names.get(id)) || nonNumeric(r.attr_campaign) || id || '(none)';
    return { key: id || r.attr_campaign || '(none)', label, campaignId: id };
  };

  // Accumulators for sale-cycle time (lead created → signed), summed in ms across
  // every sale in range; averaged into days for the totals.
  let saleTimeMs = 0;
  let saleTimeCount = 0;

  // Does a date fall inside the selected period?
  const inPeriod = (d) => {
    if (!d) return false;
    const t = new Date(d).getTime();
    return t >= fromDate.getTime() && t < toExcl.getTime();
  };

  // Which of this lead's milestones count towards the selected period.
  // Event basis: each milestone on its own date, falling back to the lead date
  // when we never recorded one (older rows). Lead basis: the lead is in range by
  // construction, so everything it produced counts with it.
  const milestones = (r, dv) => {
    const reviewed = r.status === 'qualified' || r.status === 'disqualified' || r.status === 'spam';
    if (basis === 'lead') {
      return {
        lead: true,
        qualified: r.status === 'qualified',
        disqualified: r.status === 'disqualified' || r.status === 'spam',
        proposal: !!dv && dv.proposalValue != null,
        sale: !!dv && dv.isSale,
      };
    }
    const reviewedAt = r.reviewed_at || r.created_at;
    return {
      lead: inPeriod(r.created_at),
      qualified: r.status === 'qualified' && reviewed && inPeriod(reviewedAt),
      disqualified: (r.status === 'disqualified' || r.status === 'spam') && inPeriod(reviewedAt),
      proposal: !!dv && dv.proposalValue != null && inPeriod(dv.proposalAt || r.created_at),
      sale: !!dv && dv.isSale && inPeriod(dv.saleAt || r.created_at),
    };
  };

  for (const r of rows) {
    const dv = r.deal_id ? info.get(r.deal_id) : null;
    const m = milestones(r, dv);
    // On the event basis we scanned back past `from`, so skip leads that
    // contribute nothing to the selected period.
    if (!m.lead && !m.qualified && !m.disqualified && !m.proposal && !m.sale) continue;

    const { key, label, campaignId, url } = keyFor(r);
    let g = groups.get(key);
    if (!g) { g = { key, label, campaignId: campaignId || null, url: url || null, leads: 0, qualified: 0, disqualified: 0, proposals: 0, sales: 0, revenue: 0, proposalValue: 0 }; groups.set(key, g); }
    if (m.lead) g.leads += 1;
    if (m.qualified) g.qualified += 1;
    if (m.disqualified) g.disqualified += 1;
    if (m.proposal) { g.proposals += 1; g.proposalValue += dv.proposalValue; }
    if (m.sale) {
      g.sales += 1;
      g.revenue += dv.value;
      if (dv.saleAt && r.created_at) {
        const ms = new Date(dv.saleAt).getTime() - new Date(r.created_at).getTime();
        if (ms >= 0) { saleTimeMs += ms; saleTimeCount += 1; }
      }
    }
  }

  const attachSpend = (g) => {
    let spend = null;
    if (dim === 'campaign' && g.campaignId && byCampaign.has(g.campaignId)) spend = byCampaign.get(g.campaignId).cost;
    else if (dim === 'keyword' && byKeyword.has(g.key)) spend = byKeyword.get(g.key);
    else if (dim === 'channel' && g.key === 'paid_search') spend = totalSpend;
    return spend;
  };

  const out = [...groups.values()].map((g) => {
    const spend = attachSpend(g);
    return {
      key: g.key,
      label: g.label,
      campaignId: g.campaignId,
      url: g.url,
      leads: g.leads,
      qualified: g.qualified,
      disqualified: g.disqualified,
      proposals: g.proposals,
      sales: g.sales,
      won: g.sales, // alias kept for any older consumer
      revenue: round2(g.revenue),
      proposalValue: round2(g.proposalValue),
      spend: spend == null ? null : round2(spend),
      costPerLead: spend != null && g.leads > 0 ? round2(spend / g.leads) : null,
      costPerSale: spend != null && g.sales > 0 ? round2(spend / g.sales) : null,
      roas: spend != null && spend > 0 ? round2(g.revenue / spend) : null,
      // Lead→sale rate = signed deals out of leads.
      conversionRate: g.leads > 0 ? round2((g.sales / g.leads) * 100) : 0,
      leadToSaleRate: g.leads > 0 ? round2((g.sales / g.leads) * 100) : 0,
      // Lead quality = qualified out of the leads we've actually reviewed
      // (qualified + disqualified). null until at least one has been reviewed.
      qualityRate: (g.qualified + g.disqualified) > 0
        ? round2((g.qualified / (g.qualified + g.disqualified)) * 100) : null,
    };
  }).sort((a, b) => b.revenue - a.revenue || b.leads - a.leads);

  // Totals across the period (spend = whole-account spend in range). Every row
  // lands in exactly one group, so the totals are just the column sums.
  let tLeads = 0, tQualified = 0, tDisqualified = 0, tSales = 0, tRevenue = 0, tProposalValue = 0, tProposals = 0;
  for (const g of groups.values()) {
    tLeads += g.leads; tQualified += g.qualified; tDisqualified += g.disqualified;
    tProposals += g.proposals; tProposalValue += g.proposalValue;
    tSales += g.sales; tRevenue += g.revenue;
  }
  const tReviewed = tQualified + tDisqualified;
  const tSpend = adsConfigured() ? totalSpend : null;
  const totals = {
    leads: tLeads,
    qualified: tQualified,
    disqualified: tDisqualified,
    proposalsSent: tProposals,
    sales: tSales,
    won: tSales, // alias
    revenue: round2(tRevenue),
    proposalValueSent: round2(tProposalValue),
    spend: tSpend == null ? null : round2(tSpend),
    costPerLead: tSpend != null && tLeads > 0 ? round2(tSpend / tLeads) : null,
    costPerSale: tSpend != null && tSales > 0 ? round2(tSpend / tSales) : null,
    roas: tSpend != null && tSpend > 0 ? round2(tRevenue / tSpend) : null,
    conversionRate: tLeads > 0 ? round2((tSales / tLeads) * 100) : 0,
    leadToSaleRate: tLeads > 0 ? round2((tSales / tLeads) * 100) : 0,
    // Average lead→sale time in days (lead created → signed), over sales with
    // a known sale date. null when there are no dated sales yet.
    avgLeadToSaleDays: saleTimeCount > 0 ? round2((saleTimeMs / saleTimeCount) / 86400000) : null,
    qualityRate: tReviewed > 0 ? round2((tQualified / tReviewed) * 100) : null,
  };

  return { groupBy: dim, basis, from: fromStr, to: toStr, adsConfigured: adsConfigured(), rows: out, totals };
}

// GET /api/crm/analytics/snippet — copy-ready setup strings for the Settings tab.
function snippetConfig() {
  const origin = (APP_URL || 'https://app.squideo.com').replace(/\/$/, '');
  const scriptTag = `<script src="${origin}/track.js" async></script>`;
  const finalUrlSuffix =
    'gclid={gclid}&campaignid={campaignid}&adgroupid={adgroupid}&keyword={keyword}' +
    '&matchtype={matchtype}&network={network}&device={device}&creative={creative}' +
    '&placement={placement}&utm_source=google&utm_medium=cpc&utm_campaign={campaignid}';
  // The brief-builder signup, ready to drop into a marketing page.
  //
  // Only the SIGNUP is embedded — the builder itself needs a portal session, and
  // a SameSite=Lax cookie is never sent inside a cross-site iframe, so an
  // embedded builder would be permanently signed out. The form breaks out to the
  // top level on success, which is why the iframe is NOT sandboxed: a sandbox
  // without allow-top-navigation would trap someone in the frame.
  //
  // The height listener mirrors the quote form's, and deliberately reuses the
  // same `squideo-quote-form:height` message, so a page already handling one
  // needs no second listener.
  //
  // Three variants. `landing` is the whole landing page minus the site chrome,
  // for a Duda page of its own — it mirrors squideo.com/online-brief-builder so
  // the old site and the new one make the same offer in the same words. `full`
  // carries a headline and bullets, for a homepage or process-page section where
  // nothing around it explains the offer. `compact` is just the card, for a page
  // whose own copy is already doing the selling.
  const heightListener = `<script>
window.addEventListener('message', function (e) {
  if (e.origin !== '${origin}') return;
  if (!e.data || e.data.type !== 'squideo-quote-form:height') return;
  var f = document.querySelector('iframe[src*="/brief-start"]');
  if (f) f.height = e.data.height;
});
<\/script>`;

  // Taller starting height than the others: the landing variant is three bands,
  // and `height` is only the floor until the first height message lands. Too low
  // and the page visibly jumps on load.
  const briefLandingEmbed = `<iframe src="${origin}/brief-start?variant=landing" title="Online Brief Builder"
        style="width:100%;border:0;display:block" height="1200" loading="lazy"></iframe>
${heightListener}`;

  const briefEmbedFull = `<iframe src="${origin}/brief-start?variant=full" title="Build your video brief"
        style="width:100%;border:0;display:block" height="560" loading="lazy"></iframe>
${heightListener}`;

  const briefEmbed = `<iframe src="${origin}/brief-start" title="Build your video brief"
        style="width:100%;max-width:560px;border:0;display:block;margin:0 auto"
        height="520" loading="lazy"></iframe>
${heightListener}`;

  return {
    appOrigin: origin, scriptTag, finalUrlSuffix, briefEmbed, briefEmbedFull, briefLandingEmbed,
    adsConfigured: adsConfigured(), gscConfigured: gscConfigured(), ga4Configured: ga4Configured(),
  };
}

export async function analyticsRoute(req, res, id, action, user) {
  res.setHeader('Cache-Control', 'no-store');
  const role = await getRole(user.role);
  if (!hasPermission(role, 'marketing.access')) {
    return res.status(403).json({ error: 'You do not have permission to view Marketing' });
  }

  // Manual "Sync now" (POST /api/crm/analytics/sync) — pull every connected
  // Google data source (Ads spend, Search Console, GA4) on demand using the same
  // logic as the daily crons, returning a per-source result so the UI can report
  // success/error for each. A source that isn't configured is reported skipped,
  // not failed. Runs sources independently so one failure doesn't sink the rest.
  if (req.method === 'POST' && id === 'sync') {
    if (!adsConfigured() && !gscConfigured() && !ga4Configured()) {
      return res.status(400).json({ ok: false, error: 'Nothing connected yet — add the Google Ads / GA4 / Search Console environment variables.' });
    }
    // Cap each source so one hanging upstream (esp. the Google Ads API) can't
    // burn the whole 60s function budget and return a non-JSON timeout page.
    // Sources run in parallel, so worst case ~this bound, kept under maxDuration
    // (60s). Generous enough for a healthy GSC pull (~20k rows) which was
    // borderline at 25s under contention with the other two sources.
    const PER_SOURCE_MS = 45000;
    const runSafe = async (fn, label) => {
      try {
        return await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, rej) => setTimeout(
            () => rej(new Error(`${label} timed out after ${PER_SOURCE_MS / 1000}s`)), PER_SOURCE_MS)),
        ]);
      } catch (err) { return { ok: false, error: err?.message || 'failed' }; }
    };
    const [ads, gsc, ga4] = await Promise.all([
      adsConfigured() ? runSafe(runAdSpendSync, 'Google Ads sync') : { ok: false, skipped: 'not_configured' },
      gscConfigured() ? runSafe(runGscSync, 'Search Console sync') : { ok: false, skipped: 'not_configured' },
      ga4Configured() ? runSafe(runGa4Sync, 'GA4 sync') : { ok: false, skipped: 'not_configured' },
    ]);
    await Promise.all([
      recordSyncStatus('ads', ads),
      recordSyncStatus('gsc', gsc),
      recordSyncStatus('ga4', ga4),
    ]);
    const ok = [ads, gsc, ga4].some((r) => r?.ok);
    return res.status(200).json({ ok, ads, gsc, ga4 });
  }

  // One-off Search Console historical backfill. The daily sync only re-pulls a
  // trailing 30 days, so everything older than that has never been stored —
  // and Google drops it entirely at 16 months. Run this to capture the archive
  // (notably: the per-URL baseline a site migration is measured against).
  //
  // Resumable by design — 16 months is more upstream calls than one invocation
  // can make. Call it, then keep calling it with the `nextStartDaysAgo` it hands
  // back until `done` is true. Writes are upserts, so repeating a chunk is safe.
  if (req.method === 'POST' && id === 'gsc-backfill') {
    if (!gscConfigured()) {
      return res.status(400).json({ ok: false, error: 'Search Console is not connected — add the Google OAuth and GSC_SITE_URL environment variables.' });
    }
    const months = Number(req.body?.months) || 16;
    const startDaysAgo = Number(req.body?.startDaysAgo) || 0;
    const r = await runGscBackfill({ months, startDaysAgo });
    return res.status(200).json(r);
  }

  // Marketing data cutoff — the "show leads from" date. GET reads it; PUT/POST
  // sets it (excludes earlier, incomplete-attribution leads from the reports).
  if (id === 'settings') {
    if (req.method === 'GET') return res.status(200).json({ leadsFrom: await getMarketingCutoff() });
    if (req.method === 'POST' || req.method === 'PUT') {
      await ensureMarketingCutoff();
      const v = typeof req.body?.leadsFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.leadsFrom) ? req.body.leadsFrom : null;
      if (!v) return res.status(400).json({ error: 'leadsFrom must be a YYYY-MM-DD date' });
      await sql`UPDATE settings SET marketing_leads_from = ${v} WHERE id = 1`;
      return res.status(200).json({ leadsFrom: v });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Scrubbing a brief out of the report (or putting it back) is a WRITE, so it
  // sits ahead of the GET-only guard below — same shape as `settings` above.
  if (id === 'brief' && action && req.method === 'POST') {
    const excluded = req.body?.excluded !== false;
    const ok = await setBriefExcluded(action, excluded, user?.email || null);
    if (!ok) return res.status(404).json({ error: 'Brief not found' });
    return res.status(200).json({ id: action, excluded });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  await ensureLeadAttribution();

  if (id === 'leads') return res.status(200).json(await leadsLog(req));
  if (id === 'reports') return res.status(200).json(await reports(req, action));
  if (id === 'snippet') return res.status(200).json({ ...snippetConfig(), lastSync: await getSyncStatus() });
  if (id === 'search') {
    const { fromStr, toStr } = parseRange(req);
    return res.status(200).json({ from: fromStr, to: toStr, ...(await searchReport(fromStr, toStr)), lastSync: await getSyncStatus('gsc') });
  }
  // The brief builder's own funnel. Its own module because it joins four
  // unrelated things (briefs, portal users, the nudge queue and email tracking)
  // and none of them are lead attribution.
  if (id === 'briefs') return res.status(200).json(await briefsReport(parseRange(req)));
  if (id === 'brief') {
    const detail = action ? await briefDetail(action) : null;
    if (!detail) return res.status(404).json({ error: 'Brief not found' });
    return res.status(200).json(detail);
  }
  if (id === 'traffic') {
    const { fromStr, toStr } = parseRange(req);
    return res.status(200).json({ from: fromStr, to: toStr, ...(await trafficReport(fromStr, toStr)), lastSync: await getSyncStatus('ga4') });
  }
  return res.status(404).json({ error: 'Unknown analytics report' });
}
