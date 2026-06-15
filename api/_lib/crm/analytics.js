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
import { adsConfigured, ensureAdSpend } from './googleAds.js';

const WON_STAGES = new Set(['signed', 'paid']);
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

// effectiveValue + won flag for a set of deal ids, via annotateDeals (so the
// numbers match the pipeline). Returns Map<dealId, { value, won }>.
async function dealValueMap(dealIds) {
  const map = new Map();
  const ids = [...new Set(dealIds.filter(Boolean))];
  if (!ids.length) return map;
  const rows = await sql`SELECT * FROM deals WHERE id = ANY(${ids})`;
  const annotated = await annotateDeals(rows);
  for (const d of annotated) {
    map.set(d.id, { value: Number(d.effectiveValue) || 0, won: WON_STAGES.has(d.stage) });
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

// GET /api/crm/analytics/leads — one row per lead with attribution + the deal it
// became + the revenue it generated.
async function leadsLog(req) {
  const { fromDate, toExcl, fromStr, toStr } = parseRange(req);
  const rows = await sql`
    SELECT qr.id, qr.created_at, qr.name, qr.email, qr.company,
           qr.attr_channel, qr.attr_source, qr.attr_medium, qr.attr_campaign,
           qr.attr_campaign_id, qr.attr_keyword, qr.attr_term, qr.attr_landing_url,
           qr.status, qr.deal_id,
           d.stage AS deal_stage, d.title AS deal_title, d.company_id
      FROM quote_requests qr
      LEFT JOIN deals d ON d.id = qr.deal_id
     WHERE qr.created_at >= ${fromDate} AND qr.created_at < ${toExcl}
     ORDER BY qr.created_at DESC`;
  const values = await dealValueMap(rows.map((r) => r.deal_id));
  const leads = rows.map((r) => {
    const dv = r.deal_id ? values.get(r.deal_id) : null;
    const won = !!(dv && dv.won);
    return {
      id: r.id,
      createdAt: r.created_at,
      name: r.name || null,
      email: r.email || null,
      company: r.company || null,
      channel: r.attr_channel || null,
      source: r.attr_source || null,
      medium: r.attr_medium || null,
      campaign: r.attr_campaign || null,
      campaignId: r.attr_campaign_id || null,
      keyword: r.attr_keyword || r.attr_term || null,
      landingUrl: r.attr_landing_url || null,
      status: r.status || 'new',
      dealId: r.deal_id || null,
      dealTitle: r.deal_title || null,
      dealStage: r.deal_stage || null,
      companyId: r.company_id || null,
      won,
      revenue: won && dv ? round2(dv.value) : 0,
    };
  });
  return { from: fromStr, to: toStr, count: leads.length, leads };
}

// GET /api/crm/analytics/reports/:groupBy — aggregated per source/medium/
// campaign/keyword/channel.
async function reports(req, groupBy) {
  const dim = ['source', 'medium', 'campaign', 'keyword', 'channel'].includes(groupBy) ? groupBy : 'campaign';
  const { fromDate, toExcl, fromStr, toStr } = parseRange(req);
  const rows = await sql`
    SELECT qr.id, qr.status, qr.deal_id,
           qr.attr_channel, qr.attr_source, qr.attr_medium,
           qr.attr_campaign, qr.attr_campaign_id, qr.attr_keyword, qr.attr_term
      FROM quote_requests qr
     WHERE qr.created_at >= ${fromDate} AND qr.created_at < ${toExcl}`;
  const values = await dealValueMap(rows.map((r) => r.deal_id));
  const { byCampaign, byKeyword, total: totalSpend } = await spendBuckets(fromStr, toStr);

  // Bucket leads by the chosen dimension. For campaign we key by campaign id but
  // keep a friendly label (utm_campaign or the Google Ads name).
  const groups = new Map();
  const keyFor = (r) => {
    if (dim === 'source') return { key: r.attr_source || '(none)', label: r.attr_source || '(none)' };
    if (dim === 'medium') return { key: r.attr_medium || '(none)', label: r.attr_medium || '(none)' };
    if (dim === 'channel') return { key: r.attr_channel || 'direct', label: r.attr_channel || 'direct' };
    if (dim === 'keyword') { const k = r.attr_keyword || r.attr_term; return { key: (k || '(none)').toLowerCase(), label: k || '(none)' }; }
    // campaign
    const id = r.attr_campaign_id || null;
    const label = r.attr_campaign || (id && byCampaign.get(id)?.name) || id || '(none)';
    return { key: id || r.attr_campaign || '(none)', label, campaignId: id };
  };

  for (const r of rows) {
    const { key, label, campaignId } = keyFor(r);
    let g = groups.get(key);
    if (!g) { g = { key, label, campaignId: campaignId || null, leads: 0, qualified: 0, won: 0, revenue: 0 }; groups.set(key, g); }
    g.leads += 1;
    if (r.status === 'qualified') g.qualified += 1;
    const dv = r.deal_id ? values.get(r.deal_id) : null;
    if (dv && dv.won) { g.won += 1; g.revenue += dv.value; }
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
      leads: g.leads,
      qualified: g.qualified,
      won: g.won,
      revenue: round2(g.revenue),
      spend: spend == null ? null : round2(spend),
      costPerLead: spend != null && g.leads > 0 ? round2(spend / g.leads) : null,
      roas: spend != null && spend > 0 ? round2(g.revenue / spend) : null,
      conversionRate: g.leads > 0 ? round2((g.won / g.leads) * 100) : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue || b.leads - a.leads);

  // Totals across every lead in range (spend = whole-account spend in range).
  const tLeads = rows.length;
  const tQualified = rows.filter((r) => r.status === 'qualified').length;
  let tWon = 0, tRevenue = 0;
  for (const r of rows) { const dv = r.deal_id ? values.get(r.deal_id) : null; if (dv && dv.won) { tWon += 1; tRevenue += dv.value; } }
  const tSpend = adsConfigured() ? totalSpend : null;
  const totals = {
    leads: tLeads,
    qualified: tQualified,
    won: tWon,
    revenue: round2(tRevenue),
    spend: tSpend == null ? null : round2(tSpend),
    costPerLead: tSpend != null && tLeads > 0 ? round2(tSpend / tLeads) : null,
    roas: tSpend != null && tSpend > 0 ? round2(tRevenue / tSpend) : null,
    conversionRate: tLeads > 0 ? round2((tWon / tLeads) * 100) : 0,
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
  return { appOrigin: origin, scriptTag, finalUrlSuffix, adsConfigured: adsConfigured() };
}

export async function analyticsRoute(req, res, id, action, user) {
  res.setHeader('Cache-Control', 'no-store');
  const role = await getRole(user.role);
  if (!hasPermission(role, 'marketing.access')) {
    return res.status(403).json({ error: 'You do not have permission to view Marketing' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  await ensureLeadAttribution();

  if (id === 'leads') return res.status(200).json(await leadsLog(req));
  if (id === 'reports') return res.status(200).json(await reports(req, action));
  if (id === 'snippet') return res.status(200).json(snippetConfig());
  return res.status(404).json({ error: 'Unknown analytics report' });
}
