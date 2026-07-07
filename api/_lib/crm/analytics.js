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
import { gscConfigured, runGscSync, searchReport } from './googleSearch.js';
import { ga4Configured, runGa4Sync, trafficReport } from './googleAnalytics.js';
import { getSyncStatus, recordSyncStatus } from './marketingSyncStatus.js';
import { isSignedSale } from './signedSale.js';

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
// Map<dealId, { value, stage, proposalValue, isSale, saleAt }>:
//   value         — effectiveValue (signed > latest proposal > manual)
//   proposalValue — effectiveValue when a proposal exists (else null)
//   isSale        — genuine signed sale per ./signedSale.js (signature or a
//                   signed/paid stage, real value, not an import; bare long_term
//                   with no signature does NOT count)
//   saleAt        — earliest signature signed_at (fallback: stage_changed_at)
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
// campaign/keyword/channel.
async function reports(req, groupBy) {
  const dim = ['source', 'medium', 'campaign', 'keyword', 'channel'].includes(groupBy) ? groupBy : 'campaign';
  const { fromDate, toExcl, fromStr, toStr } = await leadRange(req);
  const rows = await sql`
    SELECT qr.id, qr.status, qr.deal_id, qr.created_at,
           qr.attr_channel, qr.attr_source, qr.attr_medium,
           qr.attr_campaign, qr.attr_campaign_id, qr.attr_keyword, qr.attr_term
      FROM quote_requests qr
     WHERE qr.created_at >= ${fromDate} AND qr.created_at < ${toExcl}`;
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
    // campaign — prefer the friendly name, then a non-numeric utm_campaign, then the id.
    const id = r.attr_campaign_id || null;
    const label = (id && names.get(id)) || nonNumeric(r.attr_campaign) || id || '(none)';
    return { key: id || r.attr_campaign || '(none)', label, campaignId: id };
  };

  // Accumulators for sale-cycle time (lead created → signed), summed in ms across
  // every sale in range; averaged into days for the totals.
  let saleTimeMs = 0;
  let saleTimeCount = 0;

  for (const r of rows) {
    const { key, label, campaignId } = keyFor(r);
    let g = groups.get(key);
    if (!g) { g = { key, label, campaignId: campaignId || null, leads: 0, qualified: 0, disqualified: 0, proposals: 0, sales: 0, revenue: 0, proposalValue: 0 }; groups.set(key, g); }
    g.leads += 1;
    if (r.status === 'qualified') g.qualified += 1;
    else if (r.status === 'disqualified' || r.status === 'spam') g.disqualified += 1;
    const dv = r.deal_id ? info.get(r.deal_id) : null;
    if (dv) {
      if (dv.proposalValue != null) { g.proposals += 1; g.proposalValue += dv.proposalValue; }
      if (dv.isSale) {
        g.sales += 1;
        g.revenue += dv.value;
        if (dv.saleAt && r.created_at) {
          const ms = new Date(dv.saleAt).getTime() - new Date(r.created_at).getTime();
          if (ms >= 0) { saleTimeMs += ms; saleTimeCount += 1; }
        }
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

  // Totals across every lead in range (spend = whole-account spend in range).
  const tLeads = rows.length;
  const tQualified = rows.filter((r) => r.status === 'qualified').length;
  const tDisqualified = rows.filter((r) => r.status === 'disqualified' || r.status === 'spam').length;
  const tReviewed = tQualified + tDisqualified;
  let tSales = 0, tRevenue = 0, tProposalValue = 0, tProposals = 0;
  for (const r of rows) {
    const dv = r.deal_id ? info.get(r.deal_id) : null;
    if (!dv) continue;
    if (dv.proposalValue != null) { tProposals += 1; tProposalValue += dv.proposalValue; }
    if (dv.isSale) { tSales += 1; tRevenue += dv.value; }
  }
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

  return { groupBy: dim, from: fromStr, to: toStr, adsConfigured: adsConfigured(), rows: out, totals };
}

// GET /api/crm/analytics/snippet — copy-ready setup strings for the Settings tab.
function snippetConfig() {
  const origin = (APP_URL || 'https://app.squideo.com').replace(/\/$/, '');
  const scriptTag = `<script src="${origin}/track.js" async></script>`;
  const finalUrlSuffix =
    'gclid={gclid}&campaignid={campaignid}&adgroupid={adgroupid}&keyword={keyword}' +
    '&matchtype={matchtype}&network={network}&device={device}&creative={creative}' +
    '&placement={placement}&utm_source=google&utm_medium=cpc&utm_campaign={campaignid}';
  return {
    appOrigin: origin, scriptTag, finalUrlSuffix,
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

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  await ensureLeadAttribution();

  if (id === 'leads') return res.status(200).json(await leadsLog(req));
  if (id === 'reports') return res.status(200).json(await reports(req, action));
  if (id === 'snippet') return res.status(200).json({ ...snippetConfig(), lastSync: await getSyncStatus() });
  if (id === 'search') {
    const { fromStr, toStr } = parseRange(req);
    return res.status(200).json({ from: fromStr, to: toStr, ...(await searchReport(fromStr, toStr)), lastSync: await getSyncStatus('gsc') });
  }
  if (id === 'traffic') {
    const { fromStr, toStr } = parseRange(req);
    return res.status(200).json({ from: fromStr, to: toStr, ...(await trafficReport(fromStr, toStr)), lastSync: await getSyncStatus('ga4') });
  }
  return res.status(404).json({ error: 'Unknown analytics report' });
}
