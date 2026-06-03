import sql from '../db.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { allCompanyBalances } from './companies.js';

// Business finance/performance aggregates across ALL customers. Unions the same
// five paid-money sources as companies.js (allCompanyBalances /
// computeCompanyLifetime) so the headline totals reconcile with the per-company
// pages. Read-only; gated behind settings.manage (whole-business figures).
//
// Routes (period travels in the `action` segment so it survives the vercel.json
// path→query rewrite without relying on query-string preservation):
//   GET /api/crm/stats/finance[/<year>]        → monthly net/VAT/gross + YTD + quarters
//   GET /api/crm/stats/performance[/<YYYY-MM>] → per-day net/VAT/gross for the month

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

// Split an inc-VAT amount into net (ex-VAT) and VAT using a fractional rate
// (0.2 = 20%). vatRate is stored on the proposal as a fraction.
function splitVat(inc, rate) {
  const gross = Number(inc) || 0;
  const r = Number(rate) || 0;
  const net = r > 0 ? gross / (1 + r) : gross;
  return { gross, net, vat: gross - net };
}

const monthKey = (d) => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
const dayKey = (d) => monthKey(d) + '-' + String(d.getUTCDate()).padStart(2, '0');

// Every paid-money row across all customers with paid_at in [sinceISO, untilISO).
// Returns [{ paidAt: Date, net, vat, gross }]. Dates are bucketed in UTC, matching
// the leaderboard's existing convention.
async function fetchPaidRows(sinceISO, untilISO) {
  const [stripeR, partnerR, manualR, invR, pbR] = await Promise.all([
    sql`SELECT pay.amount AS inc, pay.paid_at, pr.data->>'vatRate' AS rate
          FROM payments pay JOIN proposals pr ON pr.id = pay.proposal_id
         WHERE pay.paid_at >= ${sinceISO} AND pay.paid_at < ${untilISO}`,
    sql`SELECT pi.amount AS inc, pi.paid_at, pr.data->>'vatRate' AS rate
          FROM partner_invoices pi JOIN proposals pr ON pr.id = pi.proposal_id
         WHERE pi.paid_at >= ${sinceISO} AND pi.paid_at < ${untilISO}`,
    sql`SELECT mp.amount AS inc, mp.paid_at, pr.data->>'vatRate' AS rate
          FROM manual_payments mp JOIN proposals pr ON pr.id = mp.proposal_id
         WHERE mp.manual_invoice_id IS NULL
           AND mp.paid_at >= ${sinceISO} AND mp.paid_at < ${untilISO}`,
    sql`SELECT mi.amount AS inc, mi.paid_at, mi.subtotal_ex_vat, mi.tax_amount,
               pr.data->>'vatRate' AS rate
          FROM manual_invoices mi
          LEFT JOIN proposals pr ON pr.id = mi.proposal_id
         WHERE mi.status = 'paid'
           AND mi.paid_at >= ${sinceISO} AND mi.paid_at < ${untilISO}`,
    sql`SELECT pb.paid_amount AS inc, pb.paid_at, pr.data->>'vatRate' AS rate
          FROM proposal_billing pb JOIN proposals pr ON pr.id = pb.proposal_id
         WHERE pb.paid_amount IS NOT NULL
           AND pb.paid_at >= ${sinceISO} AND pb.paid_at < ${untilISO}`,
  ]);

  const rows = [];
  const push = (paidAt, parts) => { if (paidAt) rows.push({ paidAt: new Date(paidAt), ...parts }); };

  for (const r of stripeR) push(r.paid_at, splitVat(r.inc, r.rate));
  for (const r of partnerR) push(r.paid_at, splitVat(r.inc, r.rate));
  for (const r of manualR) push(r.paid_at, splitVat(r.inc, r.rate));
  for (const r of invR) {
    // Prefer the invoice's own stored VAT breakdown (most accurate, incl.
    // company-level invoices with no linked proposal); fall back to the linked
    // proposal's rate; else treat as zero-rated.
    const gross = Number(r.inc) || 0;
    if (r.subtotal_ex_vat != null || r.tax_amount != null) {
      const net = r.subtotal_ex_vat != null ? Number(r.subtotal_ex_vat) : gross - (Number(r.tax_amount) || 0);
      const vat = r.tax_amount != null ? Number(r.tax_amount) : gross - net;
      push(r.paid_at, { gross, net, vat });
    } else {
      push(r.paid_at, splitVat(gross, r.rate));
    }
  }
  for (const r of pbR) push(r.paid_at, splitVat(r.inc, r.rate));

  return rows;
}

async function financeReport(year) {
  const since = `${year}-01-01T00:00:00.000Z`;
  const until = `${year + 1}-01-01T00:00:00.000Z`;
  const rows = await fetchPaidRows(since, until);

  const monthsMap = {};
  for (let m = 1; m <= 12; m++) monthsMap[`${year}-${String(m).padStart(2, '0')}`] = { net: 0, vat: 0, gross: 0 };
  for (const r of rows) {
    const b = monthsMap[monthKey(r.paidAt)];
    if (!b) continue;
    b.net += r.net; b.vat += r.vat; b.gross += r.gross;
  }
  const months = Object.entries(monthsMap).map(([month, v]) => ({
    month, net: round2(v.net), vat: round2(v.vat), gross: round2(v.gross),
  }));

  // YTD: whole year for a past year, else up to (and including) the current month.
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const ytd = { net: 0, vat: 0, gross: 0 };
  for (const m of months) {
    const mi = Number(m.month.slice(5)) - 1;
    if (year < curYear || (year === curYear && mi <= now.getUTCMonth())) {
      ytd.net += m.net; ytd.vat += m.vat; ytd.gross += m.gross;
    }
  }

  // Calendar quarters — UK VAT returns are filed quarterly, so a quarter roll-up
  // of the VAT-to-save is handy alongside the monthly view.
  const quarters = [0, 1, 2, 3].map((q) => {
    const qm = months.slice(q * 3, q * 3 + 3);
    return {
      label: `Q${q + 1} ${year}`,
      net: round2(qm.reduce((s, x) => s + x.net, 0)),
      vat: round2(qm.reduce((s, x) => s + x.vat, 0)),
      gross: round2(qm.reduce((s, x) => s + x.gross, 0)),
    };
  });

  // Outstanding across all customers (inc-VAT — it's the cash still to come in).
  let outstanding = 0;
  try {
    const balances = await allCompanyBalances();
    for (const b of Object.values(balances)) outstanding += Number(b.outstanding) || 0;
  } catch { /* non-fatal — the finance figures are the headline */ }

  return {
    year,
    months,
    ytd: { net: round2(ytd.net), vat: round2(ytd.vat), gross: round2(ytd.gross) },
    quarters,
    outstanding: round2(outstanding),
  };
}

async function performanceReport(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const since = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const until = new Date(Date.UTC(y, m, 1)).toISOString();
  const rows = await fetchPaidRows(since, until);

  const byDay = {};
  for (const r of rows) {
    const k = dayKey(r.paidAt);
    if (!byDay[k]) byDay[k] = { net: 0, vat: 0, gross: 0 };
    byDay[k].net += r.net; byDay[k].vat += r.vat; byDay[k].gross += r.gross;
  }
  const days = Object.entries(byDay)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, v]) => ({ date, net: round2(v.net), vat: round2(v.vat), gross: round2(v.gross) }));

  return { month: monthStr, days };
}

export async function statsRoute(req, res, id, action, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Whole-business finances — owner/admin only.
  if (!hasPermission(await getRole(user.role), 'settings.manage')) {
    return res.status(403).json({ error: 'You do not have permission to view business finances' });
  }

  if (id === 'finance') {
    const year = parseInt(action, 10) || new Date().getUTCFullYear();
    return res.status(200).json(await financeReport(year));
  }

  if (id === 'performance') {
    const now = new Date();
    const month = /^\d{4}-\d{2}$/.test(action || '')
      ? action
      : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return res.status(200).json(await performanceReport(month));
  }

  return res.status(404).json({ error: 'Unknown stats report' });
}
