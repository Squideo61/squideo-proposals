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
// Optional env NEON_PROJECT_ID — otherwise the first project on the account is used.
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

// Sum every numeric consumption metric across the periods/datapoints the API
// returns for the window. The v2 endpoint nests metrics under
// projects[].periods[].consumption[] — we flatten and add up the fields we bill on.
function sumMetrics(payload) {
  const totals = {
    compute_unit_seconds: 0,
    root_branch_bytes_month: 0,
    child_branch_bytes_month: 0,
    instant_restore_bytes_month: 0,
    public_network_transfer_bytes: 0,
    private_network_transfer_bytes: 0,
  };
  const add = (point) => {
    for (const k of Object.keys(totals)) {
      const v = Number(point?.[k]);
      if (Number.isFinite(v)) totals[k] += v;
    }
  };
  for (const project of payload?.projects || []) {
    for (const period of project?.periods || []) {
      for (const point of period?.consumption || []) add(point);
    }
  }
  return totals;
}

async function compute(key, projectIdEnv) {
  // Resolve the project: explicit env wins, else take the first on the account.
  let projectId = projectIdEnv;
  let projectName = null;
  if (!projectId) {
    const list = await neonGet('/projects', key);
    const first = (list?.projects || [])[0];
    if (!first) throw new Error('No Neon projects found for this API key');
    projectId = first.id;
    projectName = first.name;
  }

  // Current billing period to date: start of this UTC month → now.
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const to = now.toISOString();
  const qs = new URLSearchParams({
    from, to, granularity: 'monthly', project_ids: projectId,
  });
  const usagePayload = await neonGet(`/consumption_history/v2/projects?${qs}`, key);
  const m = sumMetrics(usagePayload);

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
    projectId,
    projectName,
    period: { from, to },
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
    const data = await compute(key, process.env.NEON_PROJECT_ID);
    cache = { at: Date.now(), data };
    return res.status(200).json({ ...data, cached: false });
  } catch (err) {
    console.error('[neon-usage]', err);
    return res.status(500).json({ error: err?.message || 'Could not fetch Neon usage' });
  }
}
