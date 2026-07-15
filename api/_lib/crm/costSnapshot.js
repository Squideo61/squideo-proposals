// Monthly CRM-cost snapshots. The live Storage & CRM costs tab can only ever
// show *current* figures: Vercel Blob storage and the fixed-cost list are
// point-in-time, and Neon's API reports the live billing period. To let admins
// look back at past months we persist a snapshot of the full breakdown at each
// month-end (see the `cost-snapshot` cron). Past months then read from these
// rows; the current month always reads live.
//
// Neon is the billing-period estimate at capture time; Blob + fixed costs are
// the point-in-time state at month-end — close enough for a monthly trend, and
// labelled as such in the UI.
import sql from '../db.js';
import { compute as computeBlob } from '../../blob-usage.js';
import { compute as computeNeon } from '../../neon-usage.js';

const num = (n) => Number(n) || 0;
const round2 = (n) => Number((Number(n) || 0).toFixed(2));

// CRM/hosting bills (Neon, Vercel Blob, the fixed cost-items list) are all in
// USD; the Cash Flow sheet is in GBP. Convert with a single rate, overridable
// via env when it drifts. These costs are small and already labelled estimates,
// so an approximate rate is fine. Default ~ mid-2026 GBP per USD.
export const USD_TO_GBP = (() => {
  const n = Number(process.env.USD_GBP_RATE);
  return Number.isFinite(n) && n > 0 ? n : 0.79;
})();

// GBP CRM-cost total per month for the given YYYY-MM keys, read from the
// persisted snapshots (converted from USD). Past months without a snapshot are
// £0 (snapshots only accrue forward — matches the Storage tab). The current
// month is captured daily by the cost-snapshot cron; if its row isn't present
// yet (e.g. right after first deploy), we carry the most recent snapshot total
// forward so the line isn't £0 while costs are genuinely being incurred.
export async function crmCostGbpByMonth(monthKeys, currentMonthKey) {
  await ensureSnapshotTable();
  const rows = await sql`SELECT month, total_usd FROM crm_cost_snapshots`;
  const usdByMonth = {};
  for (const r of rows) usdByMonth[r.month] = num(r.total_usd);
  const latestMonth = rows.map((r) => r.month).sort().pop() || null;
  const latestUsd = latestMonth ? usdByMonth[latestMonth] : 0;
  const out = {};
  for (const mk of monthKeys) {
    let usd = usdByMonth[mk];
    if (usd == null && mk === currentMonthKey) usd = latestUsd; // carry forward for the live month
    out[mk] = round2(num(usd) * USD_TO_GBP);
  }
  return out;
}

export async function ensureSnapshotTable() {
  await sql`CREATE TABLE IF NOT EXISTS crm_cost_snapshots (
    month       TEXT PRIMARY KEY,
    neon_usd    NUMERIC NOT NULL DEFAULT 0,
    blob_usd    NUMERIC NOT NULL DEFAULT 0,
    fixed_usd   NUMERIC NOT NULL DEFAULT 0,
    total_usd   NUMERIC NOT NULL DEFAULT 0,
    breakdown   JSONB,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
}

// Compute the full cost breakdown right now and upsert it under `monthKey`
// (YYYY-MM). Each source is gathered independently so one failing (e.g. Neon
// not configured) still records the rest.
export async function captureCostSnapshot(monthKey) {
  await ensureSnapshotTable();

  let blob = null, blobUsd = 0;
  try { blob = await computeBlob(); blobUsd = num(blob?.estMonthlyStorageUsd); }
  catch (err) { console.error('[cost-snapshot] blob failed', err?.message); }

  let neon = null, neonUsd = 0;
  const key = process.env.NEON_API_KEY;
  if (key) {
    try {
      neon = await computeNeon(key, { orgIdEnv: process.env.NEON_ORG_ID, projectIdEnv: process.env.NEON_PROJECT_ID });
      neonUsd = num(neon?.costs?.total);
    } catch (err) { console.error('[cost-snapshot] neon failed', err?.message); }
  }

  let costItems = [], fixedUsd = 0;
  try {
    const rows = await sql`SELECT cost_items FROM settings WHERE id = 1`;
    costItems = Array.isArray(rows[0]?.cost_items) ? rows[0].cost_items : [];
    fixedUsd = costItems.reduce((s, it) => s + num(it.amountUsd), 0);
  } catch (err) { console.error('[cost-snapshot] fixed failed', err?.message); }

  const total = blobUsd + neonUsd + fixedUsd;
  const breakdown = {
    neon: neon ? { costs: neon.costs, usage: neon.usage, projectName: neon.projectName, period: neon.period } : null,
    blob: blob ? { estMonthlyStorageUsd: blobUsd, totalBytes: blob.totalBytes, totalCount: blob.totalCount, breakdown: blob.breakdown } : null,
    fixed: costItems,
  };

  await sql`
    INSERT INTO crm_cost_snapshots (month, neon_usd, blob_usd, fixed_usd, total_usd, breakdown, captured_at)
    VALUES (${monthKey}, ${neonUsd}, ${blobUsd}, ${fixedUsd}, ${total}, ${JSON.stringify(breakdown)}::jsonb, NOW())
    ON CONFLICT (month) DO UPDATE SET
      neon_usd = EXCLUDED.neon_usd, blob_usd = EXCLUDED.blob_usd, fixed_usd = EXCLUDED.fixed_usd,
      total_usd = EXCLUDED.total_usd, breakdown = EXCLUDED.breakdown, captured_at = NOW()`;

  return { month: monthKey, neonUsd, blobUsd, fixedUsd, total };
}

export async function listCostSnapshots() {
  await ensureSnapshotTable();
  const rows = await sql`
    SELECT month, neon_usd, blob_usd, fixed_usd, total_usd, breakdown, captured_at
    FROM crm_cost_snapshots ORDER BY month DESC`;
  return rows.map((r) => ({
    month: r.month,
    neonUsd: num(r.neon_usd),
    blobUsd: num(r.blob_usd),
    fixedUsd: num(r.fixed_usd),
    totalUsd: num(r.total_usd),
    breakdown: r.breakdown || null,
    capturedAt: r.captured_at,
  }));
}
