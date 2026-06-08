// /api/neon-usage — Neon database usage + estimated cost for the Admin
// "Storage & CRM costs" tab. Pulls this billing period's consumption from the
// Neon Console API and estimates the monthly cost using the Launch unit prices.
//
// Neon's API returns *usage metrics*, not invoice dollars, so the $ figures here
// are estimates. Link out to the Neon Console for exact billing.
//
// GET (settings.manage). Module-cached ~1h (the consumption API is rate-limited
// to ~30 req/min/account); pass ?refresh=1 to recompute.
//
// Requires env NEON_API_KEY (Neon Console → Account settings → API keys).
// Optional env NEON_ORG_ID — otherwise the account's first organization is used.
// Optional env NEON_PROJECT_ID — otherwise all projects in the org are summed.
import { cors, requirePermission } from './_lib/middleware.js';

// Launch plan unit prices (https://neon.com/pricing, 2026). Adjust here if Neon
// changes pricing or you move to a different plan.
const COMPUTE_USD_PER_CU_HOUR = 0.14;
const STORAGE_USD_PER_GB_MONTH = 0.35;
const EGRESS_INCLUDED_GB = 500;
const EGRESS_USD_PER_GB = 0.10;
const PITR_USD_PER_GB_MONTH = 0.20;

const NEON_API = 'https://console.neon.tech/api/v2';

let cache = null; // { at, data }
const TTL_MS = 60 * 60 * 1000;

async function neonGet(path, key) {
  const res = await fetch(NEON_API + path, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Neon API ${res.status} ${res.statusText}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  return res.json();
}

const METRICS = [
  'compute_unit_seconds',
  'root_branch_bytes_month',
  'child_branch_bytes_month',
  'instant_restore_bytes_month',
  'public_network_transfer_bytes',
  'private_network_transfer_bytes',
];

// Sum each metric for the CURRENT billing period. The v2 endpoint nests data as
// projects[].periods[].consumption[], where each project may return more than one
// billing period overlapping our query window — we only want the latest (current)
// one so the figures match the Neon dashboard / invoice. Each consumption
// datapoint carries a `metrics: [{ metric_name, value }]` array (older shapes put
// the metrics as flat keys on the datapoint — handle both).
function sumMetrics(payload) {
  const totals = {};
  for (const k of METRICS) totals[k] = 0;
  let periodStart = null;

  const addPoint = (point) => {
    if (Array.isArray(point?.metrics)) {
      for (const m of point.metrics) {
        if (m && m.metric_name in totals) {
          const v = Number(m.value);
          if (Number.isFinite(v)) totals[m.metric_name] += v;
        }
      }
    } else {
      for (const k of METRICS) {
        const v = Number(point?.[k]);
        if (Number.isFinite(v)) totals[k] += v;
      }
    }
  };

  for (const project of payload?.projects || []) {
    const periods = project?.periods || [];
    if (!periods.length) continue;
    // Latest billing period = most recent period_start.
    const latest = periods.reduce((a, b) =>
      new Date(b.period_start || 0) > new Date(a.period_start || 0) ? b : a);
    if (latest.period_start && (!periodStart || new Date(latest.period_start) > new Date(periodStart))) {
      periodStart = latest.period_start;
    }
    for (const point of latest.consumption || []) addPoint(point);
  }
  return { totals, periodStart };
}

async function compute(key, { orgIdEnv, projectIdEnv } = {}) {
  // Neon now scopes every account under an organization; the consumption API
  // requires org_id. Use the configured org, else the account's first org.
  let orgId = orgIdEnv;
  if (!orgId) {
    const orgsPayload = await neonGet('/users/me/organizations', key);
    const orgs = orgsPayload?.organizations || orgsPayload?.orgs || [];
    if (!orgs.length) {
      throw new Error('No Neon organization found for this API key. Set NEON_ORG_ID, or use an API key that belongs to your organization.');
    }
    orgId = orgs[0].id;
  }

  // Optional project name (nice-to-have label); failure here is non-fatal.
  let projectName = null;
  if (projectIdEnv) {
    try {
      const p = await neonGet(`/projects/${projectIdEnv}`, key);
      projectName = p?.project?.name || null;
    } catch { /* label only */ }
  }

  // Query a ~5-week window with daily granularity, then keep only the current
  // billing period (sumMetrics). Daily avoids the monthly-granularity quirk where
  // Neon snaps both ends to the 1st of the month and rejects from == to; the
  // billing period itself comes from Neon's `period_start`, not a calendar guess.
  const now = new Date();
  const fromDate = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);
  const from = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate())).toISOString();
  const to = now.toISOString();
  const qs = new URLSearchParams({
    from, to, granularity: 'daily', org_id: orgId,
    metrics: METRICS.join(','), limit: '100',
  });
  if (projectIdEnv) qs.append('project_ids', projectIdEnv);
  const usagePayload = await neonGet(`/consumption_history/v2/projects?${qs}`, key);
  const { totals: m, periodStart } = sumMetrics(usagePayload);

  const computeCuHours = m.compute_unit_seconds / 3600;
  const storageGbMonth = (m.root_branch_bytes_month + m.child_branch_bytes_month) / 1e9;
  const pitrGbMonth = m.instant_restore_bytes_month / 1e9;
  const egressGb = m.public_network_transfer_bytes / 1e9;
  const privateEgressGb = m.private_network_transfer_bytes / 1e9;

  const costs = {
    compute: computeCuHours * COMPUTE_USD_PER_CU_HOUR,
    storage: storageGbMonth * STORAGE_USD_PER_GB_MONTH,
    egress: Math.max(0, egressGb - EGRESS_INCLUDED_GB) * EGRESS_USD_PER_GB,
    pitr: pitrGbMonth * PITR_USD_PER_GB_MONTH,
  };
  costs.total = costs.compute + costs.storage + costs.egress + costs.pitr;

  return {
    configured: true,
    orgId,
    projectId: projectIdEnv || null,
    projectName,
    period: { start: periodStart || from, to },
    usage: { computeCuHours, storageGbMonth, pitrGbMonth, egressGb, privateEgressGb },
    costs,
    pricing: {
      computeUsdPerCuHour: COMPUTE_USD_PER_CU_HOUR,
      storageUsdPerGbMonth: STORAGE_USD_PER_GB_MONTH,
      egressIncludedGb: EGRESS_INCLUDED_GB,
      egressUsdPerGb: EGRESS_USD_PER_GB,
      pitrUsdPerGbMonth: PITR_USD_PER_GB_MONTH,
    },
    computedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const auth = await requirePermission(req, res, 'settings.manage');
  if (!auth) return;

  const key = process.env.NEON_API_KEY;
  if (!key) {
    // Soft response so the tab renders a setup hint instead of an error.
    return res.status(200).json({ configured: false });
  }

  try {
    const refresh = req.query?.refresh;
    if (!refresh && cache && (Date.now() - cache.at) < TTL_MS) {
      return res.status(200).json({ ...cache.data, cached: true });
    }
    const data = await compute(key, {
      orgIdEnv: process.env.NEON_ORG_ID,
      projectIdEnv: process.env.NEON_PROJECT_ID,
    });
    cache = { at: Date.now(), data };
    return res.status(200).json({ ...data, cached: false });
  } catch (err) {
    console.error('[neon-usage]', err);
    return res.status(500).json({ error: err?.message || 'Could not fetch Neon usage' });
  }
}
