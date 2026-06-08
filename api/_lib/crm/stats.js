import sql from '../db.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { allCompanyBalances } from './companies.js';
import { outstandingExtrasByDeal, ensureDealExtrasTable } from './extras.js';
import { reconcileProposalBillingPaid } from './invoices.js';
import { archiveRecord } from './recycleBin.js';
import { getMonthlyOperatingCosts } from '../xero.js';

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

// England & Wales bank holidays from the gov.uk feed, cached per cold start (24h)
// with a hardcoded fallback so working-day pacing keeps working if the feed is
// unreachable. Returns an array of 'YYYY-MM-DD'. The SPA reads this via our own
// endpoint (same-origin) rather than hitting gov.uk directly (CSP / caching).
const BANK_HOLIDAY_FALLBACK = [
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
];
let bankHolidaysCache = null;
let bankHolidaysCacheAt = 0;
async function bankHolidaysEW() {
  const TTL = 24 * 60 * 60 * 1000;
  if (bankHolidaysCache && Date.now() - bankHolidaysCacheAt < TTL) return bankHolidaysCache;
  try {
    const r = await fetch('https://www.gov.uk/bank-holidays.json', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('gov.uk ' + r.status);
    const json = await r.json();
    const dates = (json?.['england-and-wales']?.events || []).map((e) => e.date).filter(Boolean);
    if (!dates.length) throw new Error('empty feed');
    bankHolidaysCache = dates;
    bankHolidaysCacheAt = Date.now();
    return dates;
  } catch {
    return BANK_HOLIDAY_FALLBACK;
  }
}

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

// The last `n` calendar months as 'YYYY-MM' keys, oldest first, ending at the
// current month. Used by the rolling 12-month trend charts.
function lastNMonthKeys(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(monthKey(d));
  }
  return out;
}

// Fraction of a signed deal's value that is DEFERRED (owed, not taken at
// signing) by its payment plan — the "new money owed" each sale creates:
//   full up-front → 0 · 50/50 → half · PO (paid later regardless) → all.
function deferredFraction(paymentOption) {
  if (paymentOption === 'po') return 1;
  if (paymentOption === '5050') return 0.5;
  return 0; // 'full' or unknown → taken up-front
}

// The Live Sales Sheet history (Sep-16 → May-26), [month, sales(cash in),
// pps(money owed)], seeded once into an empty table so the trend charts have
// full history on first deploy. After that the in-app importer is the source of
// truth (this only seeds when the table is empty, so edits are never clobbered).
const SALES_PPS_SEED = [
  ['2016-09', 6695, 1130], ['2016-10', 5838, 1650], ['2016-11', 6994, 20], ['2016-12', 6110, 1980],
  ['2017-01', 6597, 980], ['2017-02', 6665, 1825], ['2017-03', 8196, 2375], ['2017-04', 10765, 2477],
  ['2017-05', 8599, 2450], ['2017-06', 9168, 2895], ['2017-07', 10091, 4221], ['2017-08', 16393, 4540],
  ['2017-09', 10680, 4221], ['2017-10', 15095, 7668], ['2017-11', 15343, 10410], ['2017-12', 10396, 5841],
  ['2018-01', 10217, 9394], ['2018-02', 13797, 12710], ['2018-03', 25234, 21700], ['2018-04', 17813, 17096],
  ['2018-05', 17899, 21797], ['2018-06', 20871, 17988], ['2018-07', 14482, 20231], ['2018-08', 14143, 26172],
  ['2018-09', 20354, 30902], ['2018-10', 25841, 30992], ['2018-11', 22384, 35611], ['2018-12', 16742, 27763],
  ['2019-01', 19632, 34204], ['2019-02', 14602, 32448], ['2019-03', 25399, 29604], ['2019-04', 26454, 24307],
  ['2019-05', 21736, 35248], ['2019-06', 21558, 30582], ['2019-07', 25504, 30659], ['2019-08', 25210, 35199],
  ['2019-09', 22667, 37290], ['2019-10', 22086, 35984], ['2019-11', 21793, 41051], ['2019-12', 16407, 41378],
  ['2020-01', 21053, 43002], ['2020-02', 15028, 45810], ['2020-03', 25999, 51393], ['2020-04', 19742, 51893],
  ['2020-05', 28070, 66023], ['2020-06', 33059, 61958], ['2020-07', 26494, 62728], ['2020-08', 18951, 86378],
  ['2020-09', 24562, 68496], ['2020-10', 25745, 75817], ['2020-11', 16375, 74950], ['2020-12', 25567, 68454],
  ['2021-01', 24806, 72476], ['2021-02', 18058, 64280], ['2021-03', 35087, 52768], ['2021-04', 18089, 55341],
  ['2021-05', 11731, 51273], ['2021-06', 11634, 51251], ['2021-07', 25748, 67514], ['2021-08', 31076, 64433],
  ['2021-09', 14973, 66996], ['2021-10', 26515, 71040], ['2021-11', 25083, 64177], ['2021-12', 9375, 61915],
  ['2022-01', 28271, 50385], ['2022-02', 18337, 63962], ['2022-03', 29594, 62641], ['2022-04', 30171, 45443],
  ['2022-05', 23447, 50398], ['2022-06', 30930, 28252], ['2022-07', 28021, 45583], ['2022-08', 21284, 88472],
  ['2022-09', 15121, 104723], ['2022-10', 45092, 78909], ['2022-11', 33878, 87784], ['2022-12', 34595, 58625],
  ['2023-01', 33608, 53562], ['2023-02', 19557, 54776], ['2023-03', 32676, 79801], ['2023-04', 23162, 69410],
  ['2023-05', 34126, 74374], ['2023-06', 19698, 64607], ['2023-07', 24262, 63716], ['2023-08', 32746, 42096],
  ['2023-09', 32331, 59541], ['2023-10', 36042, 51263], ['2023-11', 32320, 87646], ['2023-12', 54130, 55692],
  ['2024-01', 28250, 29838], ['2024-02', 46568, 36517], ['2024-03', 42989, 41124], ['2024-04', 27880, 53303],
  ['2024-05', 36346, 51385], ['2024-06', 25776, 71918], ['2024-07', 31042, 68652], ['2024-08', 32214, 111950],
  ['2024-09', 41597, 95978], ['2024-10', 64329, 63874], ['2024-11', 34290, 103935], ['2024-12', 49315, 69665],
  ['2025-01', 33968, 80460], ['2025-02', 34691, 85381], ['2025-03', 41673, 72247], ['2025-04', 39889, 53324],
  ['2025-05', 29879, 35523], ['2025-06', 22959, 55578], ['2025-07', 57608, 46513], ['2025-08', 18343, 39321],
  ['2025-09', 13970, 47964], ['2025-10', 25168, 60653], ['2025-11', 27968, 53025], ['2025-12', 29551, 37988.52],
  ['2026-01', 26810, 36114.14], ['2026-02', 41140, 76424], ['2026-03', 38231, 75430], ['2026-04', 46830, 63709],
  ['2026-05', 28907, 62799.5],
];

// Imported Live Sales Sheet history: a per-month override of cash-in (sales) and
// new money owed (pps), used where the CRM predates go-live. Self-heals so the
// table exists even if db/migrations/20260605_sales_pps_history.sql wasn't run,
// and seeds SALES_PPS_SEED the first time (empty table only).
let salesPpsHistoryEnsured = null;
function ensureSalesPpsHistory() {
  if (salesPpsHistoryEnsured) return salesPpsHistoryEnsured;
  salesPpsHistoryEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS sales_pps_history (
        month      TEXT PRIMARY KEY,
        sales      NUMERIC NOT NULL DEFAULT 0,
        pps        NUMERIC NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM sales_pps_history`;
    if (count === 0) {
      const months = SALES_PPS_SEED.map((r) => r[0]);
      const sales = SALES_PPS_SEED.map((r) => r[1]);
      const pps = SALES_PPS_SEED.map((r) => r[2]);
      await sql`
        INSERT INTO sales_pps_history (month, sales, pps)
        SELECT * FROM UNNEST(${months}::text[], ${sales}::numeric[], ${pps}::numeric[])
        ON CONFLICT (month) DO NOTHING`;
    }
  })().catch((err) => { salesPpsHistoryEnsured = null; throw err; });
  return salesPpsHistoryEnsured;
}

// month -> { sales, pps } for the given month keys (robust to a missing table).
async function fetchHistoryOverrides(monthKeys) {
  const map = new Map();
  if (!monthKeys.length) return map;
  try {
    await ensureSalesPpsHistory();
    const rows = await sql`SELECT month, sales, pps FROM sales_pps_history WHERE month = ANY(${monthKeys})`;
    for (const r of rows) map.set(r.month, { sales: Number(r.sales) || 0, pps: Number(r.pps) || 0 });
  } catch { /* leave empty — fall back to computed CRM figures */ }
  return map;
}

// Manual pending payments from the Live Sales Sheet "PP's" tab — outstanding
// work that sits outside the CRM's own signed deals. [company, invoiceType,
// description, amountExVat, vat, paymentMethod, note]. Amounts sum to £34,511.55,
// the sheet's stated ex-VAT total. Seeded once into an empty table; after that
// the in-app importer / per-row delete is the source of truth.
const MANUAL_PP_SEED = [
  ['Hilary Maxwell - GO Girls - ~60s Video March 2022 (2 of 2 secured)', 'Final', '50% Final', 410.00, 82.00, 'PP', ''],
  ['Spirit Release Academy x3', 'Final', '50% Final 90s 3 of 3', 794.45, 158.89, 'PP', '1 more chase then stale'],
  ['Incentifi Ltd', '50% Final - pro rata 2/2', '2x 60s + portrait', 585.94, 117.19, 'PP', 'Cal chasing 01/04/26'],
  ['Meliora', '50% Final', '1x90s +2x shorts', 712.50, 142.50, 'PP', 'picking up June'],
  ['Membership Solutions (£416.67 + V each vid = 50% final)', '50% Final', '9x vids (originally) 10 mins of content - 6 mins remaining', 2500.00, 500.00, 'PP', 'Cal chasing for more scripts 01/04/26'],
  ['PIB Employee Benefits', '50% Final P1 only', '2x 90s + subs', 875.00, 175.00, 'PP', 'est end of april'],
  ['Orbit Solution / Orbit Distribution Limited', '50% Final', '2/3 60s vids + copy', 833.33, 166.67, 'PP', ''],
  ['Orbit Solution / Orbit Distribution Limited', '50% Final', '3/3 60s vids + copy', 833.33, 166.67, 'PP', ''],
  ['University of Leicester - RAF & RAVE Trials', '50% Final (RAF)', '10 mins of content + asset pack', 2700.00, 540.00, 'PP', ''],
  ['University of Leicester - RAF & RAVE Trials', '50% Final (RAVE)', '10 mins of content + asset pack', 2700.00, 540.00, 'PP', ''],
  ['Alation (USA - $1400)', '50% Final', '2 60s vids', 1022.00, 0, 'PP', 'No VAT'],
  ['Generis', '50% Final', '2 90s vids - V1 - pro rata', 1125.00, 225.00, 'Invoiced', ''],
  ['Generis', '50% Final', '2 90s vids - V2 - pro rata', 1125.00, 225.00, 'Invoiced', ''],
  ['Drain Trader Ltd', '50% Final', '2x 60s vids', 1062.50, 212.50, 'PP', ''],
  ['TB Projects - Design & Build', '50% Final', '90s vid + script', 925.00, 185.00, 'PP', ''],
  ['TB Projects - Design & Build', 'Final', '48w Script Extension', 420.00, 84.00, 'PP', ''],
  ['Easy List Plan - Luminous Games', '50% Final', '90s of content (2 vids)', 1020.00, 204.00, 'PP', ''],
  ['Easy List Plan - Luminous Games', 'Extra', 'Human VO', 125.00, 25.00, 'PP', ''],
  ['090426 - mylife Diabetescare (Ypsomed) 6x 30s videos', '50% Final', '6x 30s + portraits', 2937.50, 587.50, 'PP', ''],
  ['Airport Coordination Ltd (UK)', '50% Final', '90s vid', 1037.50, 207.50, 'PP', ''],
  ['2026-028 Beyond PR - sobi kidney biopsy', '50% Final', '4min video + 4x mini edits', 4325.00, 865.00, 'PP', ''],
  ['ComplianceChain', '50% Final', '60s vid + VO + Priority Schedule', 1047.50, 209.50, 'PP', ''],
  ['Global Baggage Solutions', 'Final', '4 hours Revisions', 380.00, 74.00, 'Invoiced', ''],
  ['Find Your Room', '50% Deposit', '3mins Video Credit', 1500.00, 300.00, 'Invoiced', ''],
  ['Find Your Room', '50% Final', '3mins Video Credit', 1500.00, 300.00, 'PP', ''],
  ['Xantaro - XT3Lab', 'Full up front', '90s vid + VO + thumb + subs', 2015.00, 403.00, 'Invoiced', ''],
];

// Purchase orders from the Live Sales Sheet "PO's" tab. [company(project), type,
// description, amountExVat, vat, poNumber, note]. Quotes sum to £30,133.32 — the
// sheet's "Total Owed". Stored in the same table with kind='po'.
const MANUAL_PO_SEED = [
  ['#9 Somerset Safeguarding LLR Variant', 'PO Full', 'LLR Video #9', 255.00, 51.00, '40051210', 'Confirmed 06/01/2026 · PO received 23/01/26'],
  ['Ministry of Justice - (Invoice to Practice Plus Group - NHS)', 'PO Full', '16mins', 18333.33, 3666.00, 'Pending PO', 'Confirmed 17/02/26'],
  ['#12 Torbay and Devon Safeguarding Adults LLR Variant', 'PO Full', 'LLR #12', 255.00, 51.00, 'Pending PO doc for invoice', 'Confirmed 18/03/2026'],
  ['Sandip REVIVAL', 'Payment 1/3', '8 mins of content', 3763.33, 752.67, 'Pending PO', 'Confirmed 13/04/26'],
  ['Sandip REVIVAL', 'Payment 2/3', '8 mins of content', 3763.33, 752.67, 'Pending PO', 'Confirmed 13/04/26'],
  ['Sandip REVIVAL', 'Payment 3/3', '8 mins of content', 3763.33, 752.67, 'Pending PO', 'Confirmed 13/04/26'],
];

let manualPpEnsured = null;
function ensureManualPendingPayments() {
  if (manualPpEnsured) return manualPpEnsured;
  manualPpEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS manual_pending_payments (
        id             TEXT PRIMARY KEY,
        company        TEXT,
        invoice_type   TEXT,
        description    TEXT,
        amount_ex_vat  NUMERIC NOT NULL DEFAULT 0,
        vat            NUMERIC NOT NULL DEFAULT 0,
        payment_method TEXT,
        note           TEXT,
        status         TEXT NOT NULL DEFAULT 'pending',
        paid_at        TIMESTAMPTZ,
        sort_order     INT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    // Older tables (seeded before mark-as-paid / PO support) need extra columns.
    await sql`ALTER TABLE manual_pending_payments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`;
    await sql`ALTER TABLE manual_pending_payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`;
    await sql`ALTER TABLE manual_pending_payments ADD COLUMN IF NOT EXISTS paid_method TEXT`;
    await sql`ALTER TABLE manual_pending_payments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'pp'`;
    await sql`ALTER TABLE manual_pending_payments ADD COLUMN IF NOT EXISTS po_number TEXT`;
    await sql`ALTER TABLE manual_pending_payments ADD COLUMN IF NOT EXISTS deal_id TEXT`;

    // Remove accidental duplicate seed rows from a concurrent-cold-start race
    // (two instances both saw an empty table and both inserted). Keep the
    // earliest copy of each identical logical row; only ever touch UNPAID rows.
    await sql`
      DELETE FROM manual_pending_payments a
       USING manual_pending_payments b
       WHERE a.ctid > b.ctid
         AND a.status = 'pending'
         AND a.kind = b.kind
         AND COALESCE(a.company,'')      = COALESCE(b.company,'')
         AND COALESCE(a.invoice_type,'') = COALESCE(b.invoice_type,'')
         AND COALESCE(a.description,'')  = COALESCE(b.description,'')
         AND a.amount_ex_vat            = b.amount_ex_vat
         AND COALESCE(a.po_number,'')    = COALESCE(b.po_number,'')`;

    // Seeds use DETERMINISTIC ids + ON CONFLICT DO NOTHING so a concurrent
    // re-seed can never duplicate (the second insert hits the same PK).
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM manual_pending_payments`;
    if (count === 0) {
      let i = 0;
      for (const [company, invoiceType, description, amount, vat, method, note] of MANUAL_PP_SEED) {
        await sql`
          INSERT INTO manual_pending_payments (id, company, invoice_type, description, amount_ex_vat, vat, payment_method, note, sort_order, kind)
          VALUES (${'seedpp' + i}, ${company}, ${invoiceType}, ${description}, ${amount}, ${vat}, ${method}, ${note || null}, ${i}, 'pp')
          ON CONFLICT (id) DO NOTHING`;
        i += 1;
      }
    }
    // POs seed independently (the PP seed above already ran on a prior deploy).
    const [{ poCount }] = await sql`SELECT COUNT(*)::int AS "poCount" FROM manual_pending_payments WHERE kind = 'po'`;
    if (poCount === 0) {
      let i = 0;
      for (const [company, invoiceType, description, amount, vat, poNumber, note] of MANUAL_PO_SEED) {
        await sql`
          INSERT INTO manual_pending_payments (id, company, invoice_type, description, amount_ex_vat, vat, note, po_number, sort_order, kind)
          VALUES (${'seedpo' + i}, ${company}, ${invoiceType}, ${description}, ${amount}, ${vat}, ${note || null}, ${poNumber || null}, ${i}, 'po')
          ON CONFLICT (id) DO NOTHING`;
        i += 1;
      }
    }
  })().catch((err) => { manualPpEnsured = null; throw err; });
  return manualPpEnsured;
}

function serialiseManualPP(r) {
  return {
    id: r.id,
    company: r.company || null,
    invoiceType: r.invoice_type || null,
    description: r.description || null,
    amountExVat: Number(r.amount_ex_vat) || 0,
    vat: Number(r.vat) || 0,
    paymentMethod: r.payment_method || null,
    note: r.note || null,
    status: r.status || 'pending',
    paidAt: r.paid_at || null,
    kind: r.kind || 'pp',
    poNumber: r.po_number || null,
    dealId: r.deal_id || null,
  };
}

// Outstanding (unpaid) manual pending payments (robust to a missing table → []).
async function fetchManualPending() {
  try {
    await ensureManualPendingPayments();
    const rows = await sql`SELECT * FROM manual_pending_payments WHERE status <> 'paid' ORDER BY sort_order ASC NULLS LAST, created_at ASC`;
    return rows.map(serialiseManualPP);
  } catch {
    return [];
  }
}

// Normalise a company name for loose matching: lowercase, drop punctuation and
// common entity suffixes (Ltd/Limited/PLC/…), collapse whitespace.
function normCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,&]/g, ' ')
    .replace(/\b(ltd|limited|plc|llp|llc|inc|co|company|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Signed CRM deals, aggregated per deal: net signed total, company, title and the
// earliest proposal number. Shared by the auto-linker and the link picker.
async function signedDealsAgg() {
  const rows = await sql`
    SELECT d.id AS did, d.title AS title, c.name AS company,
           s.data->>'total' AS total, p.data->>'vatRate' AS rate,
           p.number_year AS ny, p.number_seq AS ns
      FROM signatures s
      JOIN proposals p ON p.id = s.proposal_id
      JOIN deals d ON d.id = p.deal_id
      LEFT JOIN companies c ON c.id = d.company_id
     WHERE (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'`;
  const byDeal = new Map();
  for (const r of rows) {
    const cur = byDeal.get(r.did) || { did: r.did, title: r.title || null, company: r.company || null, incTotal: 0, rate: 0, number: null };
    cur.incTotal += Number(r.total) || 0;
    cur.rate = Math.max(cur.rate, Number(r.rate) || 0);
    if (r.ny && r.ns && (!cur.number || Number(r.ns) < cur.number.seq)) cur.number = { year: Number(r.ny), seq: Number(r.ns) };
    byDeal.set(r.did, cur);
  }
  for (const v of byDeal.values()) v.net = v.rate > 0 ? v.incTotal / (1 + v.rate) : v.incTotal;
  return byDeal;
}

// Signed deals shaped for the "link to deal" picker.
async function linkableDeals() {
  const byDeal = await signedDealsAgg();
  return [...byDeal.values()]
    .map((d) => ({ dealId: d.did, title: d.title, company: d.company, number: d.number, net: round2(d.net) }))
    .sort((a, b) => (a.company || a.title || '').localeCompare(b.company || b.title || ''));
}

// Auto-link imported pending payments to a signed CRM deal — matched on
// normalised company name AND net amount (the full signed value or a 50/50 half,
// within a small tolerance). Only fills in a deal_id where none is set yet (never
// overrides a manual link). Returns how many rows were newly linked. Best-effort.
async function autoLinkManualToCrm() {
  try {
    await ensureManualPendingPayments();
    const [manualRows, byDeal] = await Promise.all([
      sql`SELECT id, company, amount_ex_vat FROM manual_pending_payments WHERE status <> 'paid' AND deal_id IS NULL`,
      signedDealsAgg(),
    ]);
    if (!manualRows.length || !byDeal.size) return 0;

    // normalised company → candidate deals with their acceptable net amounts.
    const byCompany = new Map();
    for (const d of byDeal.values()) {
      const key = normCompany(d.company);
      if (!key || !d.company) continue;
      const arr = byCompany.get(key) || [];
      arr.push({ did: d.did, amounts: [d.net, d.net / 2] });
      byCompany.set(key, arr);
    }
    const matchDeal = (company, amt) => {
      const cands = byCompany.get(normCompany(company));
      if (!cands) return null;
      for (const c of cands) {
        if (c.amounts.some((a) => Math.abs(a - amt) <= Math.max(0.5, a * 0.002))) return c.did;
      }
      return null;
    };

    let linked = 0;
    for (const r of manualRows) {
      const did = matchDeal(r.company, Number(r.amount_ex_vat) || 0);
      if (!did) continue;
      await sql`UPDATE manual_pending_payments SET deal_id = ${did} WHERE id = ${r.id}`;
      linked += 1;
    }
    return linked;
  } catch {
    return 0;
  }
}

// Manual pending payments MARKED PAID in [since, until) — a paid-money source so
// they flow into Income / Net revenue / cash-in alongside the five real sources.
// [{ paid_at, amount_ex_vat, vat, company }]. Robust to a missing table → [].
async function fetchPaidManualPps(sinceISO, untilISO) {
  try {
    await ensureManualPendingPayments();
    return await sql`
      SELECT id AS edit_key, paid_at, amount_ex_vat, vat, company, paid_method AS method
        FROM manual_pending_payments
       WHERE status = 'paid' AND paid_at >= ${sinceISO} AND paid_at < ${untilISO}`;
  } catch {
    return [];
  }
}

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

  // Manual pending payments marked paid — net + stored VAT.
  const ppPaid = await fetchPaidManualPps(sinceISO, untilISO);
  for (const r of ppPaid) {
    const net = Number(r.amount_ex_vat) || 0;
    const vat = Number(r.vat) || 0;
    push(r.paid_at, { net, vat, gross: net + vat });
  }

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

// A performance period: 'YYYY-MM' (month) or 'YYYY-Qn' (calendar quarter).
// Falls back to the current month. spanMonths lets the client scale targets.
function parsePerformancePeriod(action) {
  const now = new Date();
  if (/^\d{4}-Q[1-4]$/.test(action || '')) {
    const [y, q] = action.split('-Q').map(Number);
    const startM = (q - 1) * 3;
    return {
      period: action, spanMonths: 3,
      since: new Date(Date.UTC(y, startM, 1)).toISOString(),
      until: new Date(Date.UTC(y, startM + 3, 1)).toISOString(),
    };
  }
  const m = /^\d{4}-\d{2}$/.test(action || '')
    ? action
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const [y, mo] = m.split('-').map(Number);
  return {
    period: m, spanMonths: 1,
    since: new Date(Date.UTC(y, mo - 1, 1)).toISOString(),
    until: new Date(Date.UTC(y, mo, 1)).toISOString(),
  };
}

async function performanceReport(action) {
  const { period, spanMonths, since, until } = parsePerformancePeriod(action);
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

  return { period, spanMonths, since, until, days };
}

// Sales performance: new business SIGNED in the period, valued at the net
// (ex-VAT) signed total — "the cash each sale generates" — bucketed by the
// signature date. Same JS-aggregation shape as performanceReport so the client
// treats days[].net identically; `count` is the number of signings that day.
async function salesReport(action) {
  const { period, spanMonths, since, until } = parsePerformancePeriod(action);
  const rows = await sql`
    SELECT s.signed_at, (s.data->>'total')::numeric AS total, pr.data->>'vatRate' AS rate
      FROM signatures s
      JOIN proposals pr ON pr.id = s.proposal_id
     WHERE s.signed_at >= ${since} AND s.signed_at < ${until}
       AND (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'
  `;

  const byDay = {};
  for (const r of rows) {
    if (!r.signed_at) continue;
    const k = dayKey(new Date(r.signed_at));
    if (!byDay[k]) byDay[k] = { net: 0, count: 0 };
    byDay[k].net += splitVat(r.total, r.rate).net;
    byDay[k].count += 1;
  }
  const days = Object.entries(byDay)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, v]) => ({ date, net: round2(v.net), count: v.count }));

  return { period, spanMonths, since, until, days };
}

// Net (ex-VAT) VAT split for an extra: amount is stored net; vat_rate is the
// stored fraction (0.2) or null/zero for no VAT.
function extraSplit(amount, rate) {
  const net = Number(amount) || 0;
  const r = Number(rate) || 0;
  const vat = round2(net * r);
  return { net: round2(net), vat, gross: round2(net + vat) };
}

// Extras created in [since, until). Robust to the table not existing yet (returns
// []) so the sales reports always render their signings even on a fresh DB.
async function fetchExtraRows(since, until, withMeta) {
  try {
    await ensureDealExtrasTable();
    if (withMeta) {
      return await sql`
        SELECT x.id, x.created_at, x.amount, x.vat_rate, x.description,
               d.id AS deal_id, c.name AS company
          FROM deal_extras x
          LEFT JOIN deals d ON d.id = x.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE x.created_at >= ${since} AND x.created_at < ${until}`;
    }
    return await sql`
      SELECT created_at, amount, vat_rate FROM deal_extras
       WHERE created_at >= ${since} AND created_at < ${until}`;
  } catch {
    return [];
  }
}

// Monthly "cash generated" by NEW BUSINESS for a year: every deal signed valued
// at its net (ex-VAT) signed total, bucketed by signature date, PLUS ad-hoc
// extras (net) bucketed by their created date. Same monthly/quarter/YTD shape as
// financeReport so the Finance page's cards + bar chart treat it identically.
async function salesFinanceReport(year) {
  const since = `${year}-01-01T00:00:00.000Z`;
  const until = `${year + 1}-01-01T00:00:00.000Z`;

  const sigRows = await sql`
    SELECT s.signed_at, s.data->>'total' AS total, pr.data->>'vatRate' AS rate
      FROM signatures s
      JOIN proposals pr ON pr.id = s.proposal_id
     WHERE s.signed_at >= ${since} AND s.signed_at < ${until}
       AND (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'`;
  const extraRows = await fetchExtraRows(since, until, false);

  const monthsMap = {};
  for (let m = 1; m <= 12; m++) monthsMap[`${year}-${String(m).padStart(2, '0')}`] = { net: 0, vat: 0, gross: 0 };
  for (const r of sigRows) {
    if (!r.signed_at) continue;
    const b = monthsMap[monthKey(new Date(r.signed_at))];
    if (!b) continue;
    const { net, vat, gross } = splitVat(r.total, r.rate);
    b.net += net; b.vat += vat; b.gross += gross;
  }
  for (const r of extraRows) {
    if (!r.created_at) continue;
    const b = monthsMap[monthKey(new Date(r.created_at))];
    if (!b) continue;
    const { net, vat, gross } = extraSplit(r.amount, r.vat_rate);
    b.net += net; b.vat += vat; b.gross += gross;
  }
  const months = Object.entries(monthsMap).map(([month, v]) => ({
    month, net: round2(v.net), vat: round2(v.vat), gross: round2(v.gross),
  }));

  const now = new Date();
  const curYear = now.getUTCFullYear();
  const ytd = { net: 0, vat: 0, gross: 0 };
  for (const m of months) {
    const mi = Number(m.month.slice(5)) - 1;
    if (year < curYear || (year === curYear && mi <= now.getUTCMonth())) {
      ytd.net += m.net; ytd.vat += m.vat; ytd.gross += m.gross;
    }
  }

  const quarters = [0, 1, 2, 3].map((q) => {
    const qm = months.slice(q * 3, q * 3 + 3);
    return {
      label: `Q${q + 1} ${year}`,
      net: round2(qm.reduce((s, x) => s + x.net, 0)),
      vat: round2(qm.reduce((s, x) => s + x.vat, 0)),
      gross: round2(qm.reduce((s, x) => s + x.gross, 0)),
    };
  });

  return {
    year,
    months,
    ytd: { net: round2(ytd.net), vat: round2(ytd.vat), gross: round2(ytd.gross) },
    quarters,
  };
}

// A flat, newest-first ledger of cash generated in a period: one row per signing
// (the deal's net signed value) and one row per extra (net). Mirrors incomeReport
// so the Finance ledger renders both with the same component. `source` is
// 'signed' or 'extra'; `at` is the signature/created date.
async function salesLedgerReport(action) {
  const { period, since, until } = parseIncomePeriod(action);

  const sigRows = await sql`
    SELECT s.signed_at, s.data->>'total' AS total, pr.data->>'vatRate' AS rate,
           d.id AS deal_id, c.name AS company, pr.number_year AS ny, pr.number_seq AS ns
      FROM signatures s
      JOIN proposals pr ON pr.id = s.proposal_id
      LEFT JOIN deals d ON d.id = pr.deal_id
      LEFT JOIN companies c ON c.id = d.company_id
     WHERE s.signed_at >= ${since} AND s.signed_at < ${until}
       AND (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'`;
  const extraRows = await fetchExtraRows(since, until, true);

  const rows = [];
  for (const r of sigRows) {
    if (!r.signed_at) continue;
    const { net, vat, gross } = splitVat(r.total, r.rate);
    rows.push({
      at: new Date(r.signed_at).toISOString(),
      net: round2(net), vat: round2(vat), gross: round2(gross),
      source: 'signed', label: null,
      company: r.company || null,
      dealId: r.deal_id || null,
      number: r.ny && r.ns ? { year: Number(r.ny), seq: Number(r.ns) } : null,
    });
  }
  for (const r of extraRows) {
    if (!r.created_at) continue;
    const { net, vat, gross } = extraSplit(r.amount, r.vat_rate);
    rows.push({
      at: new Date(r.created_at).toISOString(),
      net, vat, gross,
      source: 'extra', label: r.description || 'Extra',
      company: r.company || null,
      dealId: r.deal_id || null,
      number: null,
    });
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const total = round2(rows.reduce((s, r) => s + r.net, 0));
  return { period, rows, total };
}

// Rolling last-N-months (default 12, ending at the current month) trend, with
// three net (ex-VAT) measures per month for the Finance charts:
//   cashIn        — cash received that month (Income / "Sales" cash-in line)
//   cashGenerated — value of work signed that month + extras created (Sales bar)
//   pps           — NEW money owed created that month (deferred portion of
//                   signings by payment plan + extras) → tomorrow's income
// Months covered by the imported Live Sales Sheet override cashIn (← sheet
// "Sales") and pps (← sheet "PP's"); cashGenerated has no sheet equivalent so it
// stays CRM-computed.
async function trendReport(action) {
  const n = Math.min(36, Math.max(1, parseInt(action, 10) || 12));
  const keys = lastNMonthKeys(n);
  const now = new Date();
  const since = new Date(Date.UTC(Number(keys[0].slice(0, 4)), Number(keys[0].slice(5)) - 1, 1)).toISOString();
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  const buckets = {};
  for (const k of keys) buckets[k] = { cashIn: 0, cashGenerated: 0, pps: 0 };

  // Cash received (Income).
  const paidRows = await fetchPaidRows(since, until);
  for (const r of paidRows) {
    const b = buckets[monthKey(r.paidAt)];
    if (b) b.cashIn += r.net;
  }

  // Signings — cash generated + the deferred (owed) portion they create.
  const sigRows = await sql`
    SELECT s.signed_at, s.data->>'total' AS total, s.data->>'paymentOption' AS opt, pr.data->>'vatRate' AS rate
      FROM signatures s
      JOIN proposals pr ON pr.id = s.proposal_id
     WHERE s.signed_at >= ${since} AND s.signed_at < ${until}
       AND (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'`;
  for (const r of sigRows) {
    if (!r.signed_at) continue;
    const b = buckets[monthKey(new Date(r.signed_at))];
    if (!b) continue;
    const net = splitVat(r.total, r.rate).net;
    b.cashGenerated += net;
    b.pps += net * deferredFraction(r.opt);
  }

  // Extras — generated value, and owed until collected.
  const extraRows = await fetchExtraRows(since, until, false);
  for (const r of extraRows) {
    if (!r.created_at) continue;
    const b = buckets[monthKey(new Date(r.created_at))];
    if (!b) continue;
    const net = Number(r.amount) || 0;
    b.cashGenerated += net;
    b.pps += net;
  }

  // Splice the imported sheet history over CRM figures where present.
  const overrides = await fetchHistoryOverrides(keys);

  const months = keys.map((month) => {
    const b = buckets[month];
    const ov = overrides.get(month);
    return {
      month,
      cashIn: round2(ov ? ov.sales : b.cashIn),
      cashGenerated: round2(b.cashGenerated),
      pps: round2(ov ? ov.pps : b.pps),
      source: ov ? 'history' : 'crm',
    };
  });

  // The latest month is a live preview: its owed point should reflect ALL
  // outstanding cash still to collect (invoiced + not-yet-invoiced), not just
  // what was newly created this month. Carried as a separate field so the
  // 36-month "new money owed" total stays a sum of monthly-created amounts.
  try {
    const last = months[months.length - 1];
    if (last) {
      const pending = await pendingPaymentsReport();
      const t = pending.totals || {};
      last.ppsOutstanding = round2((Number(t.invoiced) || 0) + (Number(t.notInvoiced) || 0));
    }
  } catch { /* non-fatal — fall back to the monthly-created figure */ }

  return { months };
}

// Outstanding balance per signed deal across all customers, split into PO-route
// deals (paid regardless of project stage) and normal invoiced work (paid on
// project milestones/completion). Amounts are ex-VAT (net) to match the rest of
// the Finance page; each deal's net is derived from its proposals' vatRate.
// Mirrors the committed/paid maths in companies.js but global and deal-grouped.
async function pendingPaymentsReport() {
  // Auto-link imported rows that match a signed CRM deal (so they show as linked).
  await autoLinkManualToCrm();
  // Freshly-issued proposal-billing invoices (e.g. a client-requested deposit)
  // store no amount until reconciled from Xero — stamp them now so the invoiced
  // tag/totals are accurate without waiting for a company page load. Bounded to
  // the few rows that actually need it.
  try {
    const need = await sql`SELECT proposal_id FROM proposal_billing WHERE xero_invoice_id IS NOT NULL AND invoice_amount IS NULL`;
    if (need.length) await reconcileProposalBillingPaid(need.map((r) => r.proposal_id));
  } catch (err) { console.error('[stats] proposal-billing reconcile failed', err?.message || err); }
  // Per signature so we can aggregate committed + the deal's VAT rate + PO flag
  // in JS (vatRate parsed as text → avoids a risky SQL numeric cast).
  const sigRows = await sql`
    SELECT d.id AS did, s.data->>'total' AS total, p.data->>'vatRate' AS rate,
           s.data->>'paymentOption' AS opt, p.number_year AS ny, p.number_seq AS ns
      FROM signatures s
      JOIN proposals p ON p.id = s.proposal_id
      JOIN deals d ON d.id = p.deal_id
     WHERE (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'
  `;
  if (!sigRows.length) {
    const manual = await fetchManualPending();
    const manualTotal = round2(manual.reduce((s, x) => s + (Number(x.amountExVat) || 0), 0));
    const manualInvoiced = round2(
      manual.filter((x) => x.status === 'invoiced').reduce((s, x) => s + (Number(x.amountExVat) || 0), 0),
    );
    // No signed CRM deals, so "not invoiced" is just the un-invoiced imports.
    const notInvoiced = round2(manualTotal - manualInvoiced);
    return { normal: [], po: [], manual, totals: { normal: 0, po: 0, manual: manualTotal, manualInvoiced, invoiced: manualInvoiced, notInvoiced } };
  }

  const committed = new Map(); // did -> inc-VAT signed total
  const rateByDeal = new Map(); // did -> max vatRate across its proposals
  const poByDeal = new Map(); // did -> on the PO route?
  const planByDeal = new Map(); // did -> '5050' | 'full' (the chosen payment plan)
  const numberByDeal = new Map(); // did -> { year, seq } of its earliest proposal
  for (const r of sigRows) {
    committed.set(r.did, (committed.get(r.did) || 0) + (Number(r.total) || 0));
    rateByDeal.set(r.did, Math.max(rateByDeal.get(r.did) || 0, Number(r.rate) || 0));
    if (r.opt === 'po') poByDeal.set(r.did, true);
    else if (!planByDeal.has(r.did) && (r.opt === '5050' || r.opt === 'full')) planByDeal.set(r.did, r.opt);
    if (r.ny && r.ns) {
      const cur = numberByDeal.get(r.did);
      if (!cur || Number(r.ns) < cur.seq) numberByDeal.set(r.did, { year: Number(r.ny), seq: Number(r.ns) });
    }
  }

  const [stripeRows, partnerRows, manualPayRows, miPaidRows, pbPaidRows, miIssuedRows, pbInvoicedRows] = await Promise.all([
    sql`SELECT d.id AS did, COALESCE(SUM(pay.amount),0) AS v
          FROM payments pay JOIN proposals p ON p.id=pay.proposal_id JOIN deals d ON d.id=p.deal_id GROUP BY d.id`,
    sql`SELECT d.id AS did, COALESCE(SUM(pi.amount),0) AS v
          FROM partner_invoices pi JOIN proposals p ON p.id=pi.proposal_id JOIN deals d ON d.id=p.deal_id GROUP BY d.id`,
    sql`SELECT d.id AS did, COALESCE(SUM(mp.amount),0) AS v
          FROM manual_payments mp JOIN proposals p ON p.id=mp.proposal_id JOIN deals d ON d.id=p.deal_id
         WHERE mp.manual_invoice_id IS NULL GROUP BY d.id`,
    sql`SELECT COALESCE(mi.deal_id, dp.id) AS did, COALESCE(SUM(mi.amount),0) AS v
          FROM manual_invoices mi
          LEFT JOIN deals dd ON dd.id = mi.deal_id
          LEFT JOIN proposals pr ON pr.id = mi.proposal_id
          LEFT JOIN deals dp ON dp.id = pr.deal_id
         WHERE mi.status='paid' GROUP BY COALESCE(mi.deal_id, dp.id)`,
    sql`SELECT d.id AS did, COALESCE(SUM(pb.paid_amount),0) AS v
          FROM proposal_billing pb JOIN proposals p ON p.id=pb.proposal_id JOIN deals d ON d.id=p.deal_id
         WHERE pb.paid_amount IS NOT NULL GROUP BY d.id`,
    // Invoiced but NOT yet paid, per deal — the only thing this report now shows
    // as "pending". Two sources of a raised-and-unpaid invoice:
    //   1) manual invoices still in 'issued' (not paid, not void) — full amount.
    //   2) proposal-billing ("email me an invoice") — invoice_amount less anything
    //      already paid against it.
    sql`SELECT COALESCE(mi.deal_id, dp.id) AS did, COALESCE(SUM(mi.amount),0) AS v
          FROM manual_invoices mi
          LEFT JOIN deals dd ON dd.id = mi.deal_id
          LEFT JOIN proposals pr ON pr.id = mi.proposal_id
          LEFT JOIN deals dp ON dp.id = pr.deal_id
         WHERE mi.status='issued' GROUP BY COALESCE(mi.deal_id, dp.id)`,
    sql`SELECT d.id AS did,
               COALESCE(SUM(GREATEST(pb.invoice_amount - COALESCE(pb.paid_amount,0), 0)),0) AS v
          FROM proposal_billing pb JOIN proposals p ON p.id=pb.proposal_id JOIN deals d ON d.id=p.deal_id
         WHERE pb.invoice_amount IS NOT NULL GROUP BY d.id`,
  ]);

  const paid = new Map();
  for (const rows of [stripeRows, partnerRows, manualPayRows, miPaidRows, pbPaidRows]) {
    for (const r of rows) { if (!r.did) continue; paid.set(r.did, (paid.get(r.did) || 0) + (Number(r.v) || 0)); }
  }

  // Inc-VAT raised-and-unpaid total per deal (the new basis for "pending").
  const invoicedDue = new Map();
  for (const rows of [miIssuedRows, pbInvoicedRows]) {
    for (const r of rows) { if (!r.did) continue; invoicedDue.set(r.did, (invoicedDue.get(r.did) || 0) + (Number(r.v) || 0)); }
  }

  // Ad-hoc extras (already net £) added to a deal during production. They ride on
  // the deal's row as their own line.
  const extrasByDeal = await outstandingExtrasByDeal();

  const dealIds = [...new Set([...committed.keys(), ...extrasByDeal.keys()])];
  const infoRows = await sql`
    SELECT d.id, d.title, d.stage, d.company_id, c.name AS company_name
      FROM deals d LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.id = ANY(${dealIds})
  `;
  const info = new Map(infoRows.map((r) => [r.id, r]));

  const normal = [];
  const po = [];
  for (const did of dealIds) {
    // "Project work" (non-PO signed deals) is no longer listed or counted here —
    // it's tracked via the imported lists / company invoices. Only POs remain.
    const isPo = !!poByDeal.get(did);
    if (!isPo) continue;
    const inc = committed.get(did) || 0;
    const paidInc = paid.get(did) || 0;
    // The full outstanding on signed work (signed − paid) — both invoiced and
    // not-yet-invoiced portions are shown; each line is tagged below.
    const outstandingInc = Math.max(0, inc - paidInc);
    const invUnpaidInc = Math.max(0, Math.min(invoicedDue.get(did) || 0, outstandingInc));
    // All unpaid extras (pending + invoiced) show; tagged by their own status.
    const extras = extrasByDeal.get(did) || [];
    const extrasNet = round2(extras.reduce((s, e) => s + (Number(e.amount) || 0), 0));
    if (outstandingInc <= 0.005 && extrasNet <= 0.005) continue;
    const rate = rateByDeal.get(did) || 0;
    const net = (v) => round2(rate > 0 ? v / (1 + rate) : v);
    const outstandingNet = net(outstandingInc);
    const invUnpaidNet = net(invUnpaidInc);
    const plan = planByDeal.get(did) || 'full';

    // Each deal becomes one or more lines, matching the labels on the sales
    // sheet. A 50/50 deal splits into its deposit (billed first) and the balance;
    // "full" and PO deals are a single line. Extras are appended as their own
    // lines. The line amounts always sum to the deal's outstanding balance.
    const lines = [];
    if (outstandingNet > 0.005) {
      if (!isPo && plan === '5050') {
        const depositOutstandingInc = Math.max(0, Math.min(outstandingInc, inc / 2 - paidInc));
        const depositNet = net(depositOutstandingInc);
        const finalNet = round2(outstandingNet - depositNet);
        if (depositNet > 0.005) lines.push({ type: 'deposit', amount: depositNet });
        if (finalNet > 0.005) lines.push({ type: 'final', amount: finalNet });
      }
      if (lines.length === 0) lines.push({ type: isPo ? 'po' : 'full', amount: outstandingNet });
    }
    // Tag each line invoiced vs not: the invoiced-but-unpaid amount covers the
    // earliest lines first (deposit before final). The rest is "not invoiced".
    let invRemain = invUnpaidNet;
    for (const l of lines) {
      if (invRemain >= l.amount - 0.005) { l.invoiced = true; invRemain = round2(invRemain - l.amount); }
      else l.invoiced = false;
    }
    for (const e of extras) {
      const amt = round2(Number(e.amount) || 0);
      if (amt > 0.005) lines.push({ type: 'extra', id: e.id, label: e.description, amount: amt, status: e.status, invoiced: e.status === 'invoiced' });
    }

    const inf = info.get(did) || {};
    const item = {
      dealId: did,
      number: numberByDeal.get(did) || null,
      title: inf.title || 'Untitled deal',
      company: inf.company_name || null,
      companyId: inf.company_id || null,
      stage: inf.stage || null,
      committed: round2(net(inc) + extrasNet),
      paid: net(paidInc),
      outstanding: round2(outstandingNet + extrasNet),
      lines,
    };
    (isPo ? po : normal).push(item);
  }
  const byOutstanding = (a, b) => b.outstanding - a.outstanding;
  normal.sort(byOutstanding);
  po.sort(byOutstanding);
  const sum = (arr) => round2(arr.reduce((s, x) => s + x.outstanding, 0));

  // Company-level invoices (raised against a company, not a signed deal — e.g. an
  // uploaded ad-hoc invoice). Issued-but-unpaid only; these are invoiced & awaiting.
  // Shaped like an imported invoiced row so they sit in the same Invoiced list,
  // tagged 'company-invoice' (shown as "not linked to a deal").
  const companyInvRows = await sql`
    SELECT mi.id, mi.company_id, c.name AS company, mi.invoice_number,
           mi.amount, mi.subtotal_ex_vat, mi.tax_amount
      FROM manual_invoices mi
      LEFT JOIN companies c ON c.id = mi.company_id
      LEFT JOIN proposals pr ON pr.id = mi.proposal_id
     WHERE mi.status = 'issued' AND mi.company_id IS NOT NULL
       AND mi.deal_id IS NULL AND pr.deal_id IS NULL
  `;
  const companyInvoices = [];
  let companyInvoicedNet = 0;
  for (const r of companyInvRows) {
    const net = r.subtotal_ex_vat != null ? Number(r.subtotal_ex_vat) : (Number(r.amount) || 0);
    if (net <= 0.005) continue;
    const vat = r.tax_amount != null ? Number(r.tax_amount) : Math.max(0, (Number(r.amount) || 0) - net);
    companyInvoicedNet += net;
    companyInvoices.push({
      id: r.id,
      kind: 'company-invoice',
      company: r.company || 'Unattributed',
      companyId: r.company_id,
      invoiceType: 'Invoice',
      description: r.invoice_number || null,
      poNumber: null,
      note: null,
      amountExVat: round2(net),
      vat: round2(vat),
      status: 'invoiced',
      dealId: null,
    });
  }
  companyInvoices.sort((a, b) => (Number(b.amountExVat) || 0) - (Number(a.amountExVat) || 0));
  companyInvoicedNet = round2(companyInvoicedNet);

  // Manual items imported from the Live Sales Sheet (kept as their own group so
  // they never double-count the CRM-computed figures above).
  const manual = await fetchManualPending();
  const manualTotal = round2(manual.reduce((s, x) => s + (Number(x.amountExVat) || 0), 0));
  // Split the imported total: invoiced (awaiting payment, counts toward the
  // Outstanding headline) vs not-yet-invoiced (still to bill).
  const manualInvoiced = round2(
    manual.filter((x) => x.status === 'invoiced').reduce((s, x) => s + (Number(x.amountExVat) || 0), 0),
  );

  // Headline split, summed from exactly what's listed: PO lines (by invoiced
  // tag) + company invoices (all invoiced) + imported items (by status).
  const sumLinesByStatus = (arr, wantInvoiced) => round2(
    arr.reduce((s, item) => s + (item.lines || []).reduce(
      (ls, l) => ls + ((!!l.invoiced === wantInvoiced) ? (Number(l.amount) || 0) : 0), 0), 0),
  );
  const invoiced = round2(sumLinesByStatus(po, true) + companyInvoicedNet + manualInvoiced);
  const notInvoiced = round2(sumLinesByStatus(po, false) + (manualTotal - manualInvoiced));

  return {
    normal, po, manual, companyInvoices,
    totals: { normal: sum(normal), po: sum(po), manual: manualTotal, manualInvoiced, companyInvoices: companyInvoicedNet, invoiced, notInvoiced },
  };
}

// GET list / POST import / DELETE one — the imported manual pending payments.
// Caller has already checked settings.manage. `action` carries the row id on
// DELETE. POST body: { rows: [{company,invoiceType,description,amountExVat,vat,paymentMethod,note}], mode }.
async function pendingManualRoute(req, res, action) {
  await ensureManualPendingPayments();

  if (req.method === 'GET') {
    return res.status(200).json({ rows: await fetchManualPending() });
  }

  if (req.method === 'DELETE') {
    if (action) {
      // Archive the row first so the delete is restorable (CRM undo).
      const [row] = await sql`SELECT * FROM manual_pending_payments WHERE id = ${action}`;
      if (row) await archiveRecord('manual_pp', action, [{ table: 'manual_pending_payments', row }], null);
      await sql`DELETE FROM manual_pending_payments WHERE id = ${action}`;
    }
    return res.status(200).json({ ok: true, rows: await fetchManualPending() });
  }

  // Mark a row paid (→ flows into Income) or back to pending. { paid, method }.
  // Or mark it invoiced (raised an invoice — moves it to the invoiced/awaiting
  // list) / back to pending: { invoiced }. Invoiced is distinct from paid.
  if (req.method === 'PATCH') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    // Link (or unlink) the row to a CRM deal. { dealId: '<id>' | null }.
    if ('dealId' in body) {
      const dealId = trimOrNull(body.dealId);
      await sql`UPDATE manual_pending_payments SET deal_id = ${dealId} WHERE id = ${action}`;
      return res.status(200).json({ ok: true, rows: await fetchManualPending() });
    }
    if ('invoiced' in body) {
      const invoiced = body.invoiced !== false; // default → invoiced
      // Never touch a row that's already paid; toggling only moves between
      // pending and invoiced, clearing any stale paid stamp.
      await sql`
        UPDATE manual_pending_payments
           SET status = ${invoiced ? 'invoiced' : 'pending'},
               paid_at = NULL, paid_method = NULL
         WHERE id = ${action} AND status <> 'paid'`;
      return res.status(200).json({ ok: true, rows: await fetchManualPending() });
    }
    const paid = body.paid !== false; // default → paid
    const method = trimOrNull(body.method);
    await sql`
      UPDATE manual_pending_payments
         SET status = ${paid ? 'paid' : 'pending'},
             paid_at = ${paid ? new Date().toISOString() : null},
             paid_method = ${paid ? (method || null) : null}
       WHERE id = ${action}`;
    return res.status(200).json({ ok: true, rows: await fetchManualPending() });
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const body = req.body || {};
    const incoming = Array.isArray(body.rows) ? body.rows : [];
    // Imports are single-kind; replace only wipes that kind so POs and PPs don't
    // clobber each other.
    const importKind = body.kind === 'po' ? 'po' : 'pp';
    if (body.mode === 'replace') await sql`DELETE FROM manual_pending_payments WHERE kind = ${importKind}`;
    const startOrder = body.mode === 'replace'
      ? 0
      : ((await sql`SELECT COALESCE(MAX(sort_order), -1) AS m FROM manual_pending_payments WHERE kind = ${importKind}`)[0].m + 1);
    let i = 0;
    for (const r of incoming) {
      const company = trimOrNull(r?.company);
      const description = trimOrNull(r?.description);
      const amount = numberOrNull(r?.amountExVat) || 0;
      if (!company && !description && !amount) continue; // skip blank rows
      const kind = importKind;
      await sql`
        INSERT INTO manual_pending_payments (id, company, invoice_type, description, amount_ex_vat, vat, payment_method, note, sort_order, kind, po_number)
        VALUES (${makeId(kind === 'po' ? 'mpo' : 'mpp')}, ${company}, ${trimOrNull(r?.invoiceType)}, ${description},
                ${amount}, ${numberOrNull(r?.vat) || 0}, ${trimOrNull(r?.paymentMethod)}, ${trimOrNull(r?.note)}, ${startOrder + i}, ${kind}, ${trimOrNull(r?.poNumber)})`;
      i += 1;
    }
    // Auto-link any rows (new or pre-existing) that match a signed CRM deal.
    const linked = await autoLinkManualToCrm();
    return res.status(200).json({ saved: i, linked, rows: await fetchManualPending() });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Income period: 'YYYY' (whole year), 'YYYY-MM' (month) or 'YYYY-Qn' (calendar
// quarter). Same window shape as parsePerformancePeriod, plus a year branch so
// the Finance page's Year mode works. Defaults to the current month.
function parseIncomePeriod(action) {
  const now = new Date();
  if (/^\d{4}$/.test(action || '')) {
    const y = Number(action);
    return {
      period: action,
      since: new Date(Date.UTC(y, 0, 1)).toISOString(),
      until: new Date(Date.UTC(y + 1, 0, 1)).toISOString(),
    };
  }
  return parsePerformancePeriod(action);
}

// A flat, newest-first ledger of every payment received in the window, across the
// same five paid-money sources as fetchPaidRows so the net total reconciles with
// the headline net revenue. Each row also carries who paid (company) and a link
// back to the deal + proposal number. Amounts split into net/VAT/gross per row.
// The income ledger reads `payment_method` from proposal_billing / manual_invoices
// to show how each payment was made. Those columns aren't guaranteed on every DB
// (proposal_billing only self-heals its paid_* columns), so ensure them once —
// otherwise the whole ledger query throws and the panel hangs on "Loading…".
let incomeColsEnsured = null;
function ensureIncomeColumns() {
  if (incomeColsEnsured) return incomeColsEnsured;
  incomeColsEnsured = (async () => {
    await sql`ALTER TABLE proposal_billing ADD COLUMN IF NOT EXISTS payment_method TEXT`;
    await sql`ALTER TABLE manual_invoices ADD COLUMN IF NOT EXISTS payment_method TEXT`;
  })().catch((err) => { incomeColsEnsured = null; throw err; });
  return incomeColsEnsured;
}

async function incomeReport(action) {
  const { period, since, until } = parseIncomePeriod(action);
  await ensureIncomeColumns();

  const [stripeR, partnerR, manualR, invR, pbR] = await Promise.all([
    sql`SELECT pay.amount AS inc, pay.paid_at, pr.data->>'vatRate' AS rate,
               d.id AS deal_id, c.name AS company, pr.number_year AS ny, pr.number_seq AS ns
          FROM payments pay
          JOIN proposals pr ON pr.id = pay.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE pay.paid_at >= ${since} AND pay.paid_at < ${until}`,
    sql`SELECT pi.amount AS inc, pi.paid_at, pr.data->>'vatRate' AS rate,
               d.id AS deal_id, c.name AS company, pr.number_year AS ny, pr.number_seq AS ns
          FROM partner_invoices pi
          JOIN proposals pr ON pr.id = pi.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE pi.paid_at >= ${since} AND pi.paid_at < ${until}`,
    sql`SELECT mp.amount AS inc, mp.paid_at, pr.data->>'vatRate' AS rate, mp.id AS edit_key, mp.payment_method AS method,
               d.id AS deal_id, c.name AS company, pr.number_year AS ny, pr.number_seq AS ns
          FROM manual_payments mp
          JOIN proposals pr ON pr.id = mp.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE mp.manual_invoice_id IS NULL
           AND mp.paid_at >= ${since} AND mp.paid_at < ${until}`,
    sql`SELECT mi.amount AS inc, mi.paid_at, mi.subtotal_ex_vat, mi.tax_amount,
               pr.data->>'vatRate' AS rate, mi.id AS edit_key, mi.payment_method AS method,
               COALESCE(mi.deal_id, pr.deal_id) AS deal_id,
               COALESCE(dd.company_id, dp.company_id) AS company_id,
               COALESCE(cd.name, cp.name) AS company,
               pr.number_year AS ny, pr.number_seq AS ns
          FROM manual_invoices mi
          LEFT JOIN proposals pr ON pr.id = mi.proposal_id
          LEFT JOIN deals dd ON dd.id = mi.deal_id
          LEFT JOIN deals dp ON dp.id = pr.deal_id
          LEFT JOIN companies cd ON cd.id = dd.company_id
          LEFT JOIN companies cp ON cp.id = dp.company_id
         WHERE mi.status = 'paid'
           AND mi.paid_at >= ${since} AND mi.paid_at < ${until}`,
    sql`SELECT pb.paid_amount AS inc, pb.paid_at, pr.data->>'vatRate' AS rate, pb.xero_invoice_id AS edit_key, pb.payment_method AS method,
               d.id AS deal_id, c.name AS company, pr.number_year AS ny, pr.number_seq AS ns
          FROM proposal_billing pb
          JOIN proposals pr ON pr.id = pb.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE pb.paid_amount IS NOT NULL
           AND pb.paid_at >= ${since} AND pb.paid_at < ${until}`,
  ]);

  const rows = [];
  const push = (r, source, parts) => {
    if (!r.paid_at) return;
    rows.push({
      paidAt: new Date(r.paid_at).toISOString(),
      net: round2(parts.net), vat: round2(parts.vat), gross: round2(parts.gross),
      source,
      company: r.company || null,
      dealId: r.deal_id || null,
      number: r.ny && r.ns ? { year: Number(r.ny), seq: Number(r.ns) } : null,
      // Targets the underlying row for a date back-date (null = not editable).
      editKey: r.edit_key || null,
      // How the payment was made (Stripe is implicit for stripe/partner sources).
      method: r.method || (source === 'stripe' || source === 'partner' ? 'stripe' : null),
    });
  };

  for (const r of stripeR) push(r, 'stripe', splitVat(r.inc, r.rate));
  for (const r of partnerR) push(r, 'partner', splitVat(r.inc, r.rate));
  for (const r of manualR) push(r, 'manual', splitVat(r.inc, r.rate));
  for (const r of invR) {
    // Prefer the invoice's own stored VAT breakdown (matches fetchPaidRows).
    const gross = Number(r.inc) || 0;
    if (r.subtotal_ex_vat != null || r.tax_amount != null) {
      const net = r.subtotal_ex_vat != null ? Number(r.subtotal_ex_vat) : gross - (Number(r.tax_amount) || 0);
      const vat = r.tax_amount != null ? Number(r.tax_amount) : gross - net;
      push(r, 'invoice', { gross, net, vat });
    } else {
      push(r, 'invoice', splitVat(gross, r.rate));
    }
  }
  for (const r of pbR) push(r, 'billing', splitVat(r.inc, r.rate));

  // Manual pending payments marked paid — show in the ledger with their stored VAT.
  const ppPaid = await fetchPaidManualPps(since, until);
  for (const r of ppPaid) {
    const net = Number(r.amount_ex_vat) || 0;
    const vat = Number(r.vat) || 0;
    push(r, 'sheet', { net, vat, gross: net + vat });
  }

  rows.sort((a, b) => (a.paidAt < b.paidAt ? 1 : a.paidAt > b.paidAt ? -1 : 0));
  const total = round2(rows.reduce((s, r) => s + r.net, 0));

  return { period, rows, total };
}

// Bulk upsert / list of the imported Live Sales Sheet history. Gated (caller has
// already checked settings.manage). Body: { rows: [{month,sales,pps}], mode }.
async function historyRoute(req, res) {
  await ensureSalesPpsHistory();

  if (req.method === 'GET') {
    const rows = await sql`SELECT month, sales, pps FROM sales_pps_history ORDER BY month ASC`;
    return res.status(200).json({ rows: rows.map((r) => ({ month: r.month, sales: Number(r.sales) || 0, pps: Number(r.pps) || 0 })) });
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const body = req.body || {};
    const incoming = Array.isArray(body.rows) ? body.rows : [];
    const clean = [];
    for (const r of incoming) {
      const month = typeof r?.month === 'string' ? r.month.trim() : '';
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      clean.push({ month, sales: Number(r.sales) || 0, pps: Number(r.pps) || 0 });
    }
    if (body.mode === 'replace') await sql`DELETE FROM sales_pps_history`;
    for (const r of clean) {
      await sql`
        INSERT INTO sales_pps_history (month, sales, pps, updated_at)
        VALUES (${r.month}, ${r.sales}, ${r.pps}, NOW())
        ON CONFLICT (month) DO UPDATE SET sales = EXCLUDED.sales, pps = EXCLUDED.pps, updated_at = NOW()`;
    }
    const rows = await sql`SELECT month, sales, pps FROM sales_pps_history ORDER BY month ASC`;
    return res.status(200).json({ saved: clean.length, rows: rows.map((r) => ({ month: r.month, sales: Number(r.sales) || 0, pps: Number(r.pps) || 0 })) });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Back-date (or forward-date) an income-ledger payment. Each source maps to a
// table + key column; only these internal sources are editable (Stripe/partner
// rows are Stripe-authoritative). Body: { source, key, paidAt: 'YYYY-MM-DD' }.
async function incomeDateRoute(req, res) {
  if (req.method !== 'POST' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  const { source, key, paidAt } = req.body || {};
  if (!key || !paidAt) return res.status(400).json({ error: 'key and paidAt required' });
  const d = new Date(paidAt);
  if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date' });
  const iso = d.toISOString().slice(0, 10);
  // Templated per source so the table/column are never interpolated.
  if (source === 'billing') {
    await sql`UPDATE proposal_billing SET paid_at = ${iso}, updated_at = NOW() WHERE xero_invoice_id = ${key}`;
  } else if (source === 'invoice') {
    await sql`UPDATE manual_invoices SET paid_at = ${iso}, updated_at = NOW() WHERE id = ${key}`;
  } else if (source === 'manual') {
    await sql`UPDATE manual_payments SET paid_at = ${iso} WHERE id = ${key}`;
  } else if (source === 'sheet') {
    await sql`UPDATE manual_pending_payments SET paid_at = ${iso} WHERE id = ${key}`;
  } else {
    return res.status(400).json({ error: 'This payment type cannot be re-dated here' });
  }
  return res.status(200).json({ ok: true, paidAt: iso });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cash Flow — company costs, monthly profit, Corporation Tax to set aside and a
// suggested revenue target. Admin-only (rides on the same settings.manage gate
// as the rest of stats). Self-heals its tables so a missing migration never 500s.
// ─────────────────────────────────────────────────────────────────────────────

// One-time seed of the company's monthly cost base (owner's cost sheet, Jun 2026).
// Recurring overheads apply to every month (effective_from NULL) so the trailing
// 12-month profit / Corporation Tax estimate is meaningful; the two director
// allowances are one-offs in 2026-06. Items with no cost on the source sheet
// (cancelled / blank / paid-off) are omitted. Seeded only into an EMPTY table —
// after that the in-app editor is the source of truth, so edits are never
// clobbered. [label, category('wages'|'expense'), amount, recurring, month|null].
const CASHFLOW_COST_SEED = [
  // Software & subscriptions.
  ['Kendall Accountant', 'expense', 150.00, true, null],
  ['mr horse 3x Licenses', 'expense', 47.00, true, null],
  ['YouTube Premium family', 'expense', 20.00, true, null],
  ['Monday.com', 'expense', 210.00, true, null],
  ['Xero', 'expense', 50.20, true, null],
  ['G Suite', 'expense', 300.00, true, null],
  ['Adobe Team Creative Cloud', 'expense', 247.96, true, null],
  ['Streak', 'expense', 91.50, true, null],
  ['Subly Premium', 'expense', 39.00, true, null],
  ['Microsoft Office x4 licenses', 'expense', 60.48, true, null],
  ['Go Prospero (proposals) - 2 users', 'expense', 18.00, true, null],
  ['Duda Websites', 'expense', 81.00, true, null],
  ['Freepik + Flaticon Subscription (2 accounts)', 'expense', 20.00, true, null],
  ['Voice over spend estimation - Fiverr', 'expense', 750.00, true, null],
  ['Spotify Family', 'expense', 15.00, true, null],
  ['Vimeo Annual Membership', 'expense', 5.75, true, null],
  ['WeTransfer', 'expense', 21.00, true, null],
  ['Envato Elements', 'expense', 75.00, true, null],
  ['Netflix', 'expense', 21.00, true, null],
  ['Vercel (Squideo custom software)', 'expense', 18.00, true, null],
  ['ChatGPT', 'expense', 27.00, true, null],
  ['Loom', 'expense', 18.00, true, null],
  ['iCloud', 'expense', 8.99, true, null],
  ['Natural Reader - AI voiceover generator', 'expense', 8.00, true, null],
  // Direct debits.
  ['Phone Contracts', 'expense', 32.00, true, null],
  ['Windsor Telecom', 'expense', 40.14, true, null],
  ['AXA Specialist Risk Insurance (liability + indemnity)', 'expense', 85.00, true, null],
  ['Bank Overdraft Fee', 'expense', 31.25, true, null],
  ['Misc bank charges', 'expense', 50.00, true, null],
  ['Ben Car Lease', 'expense', 339.00, true, null],
  // Marketing.
  ['PPC Budget UK', 'marketing', 3000.00, true, null],
  ['Sophie Risan - Marketing Fee', 'marketing', 600.00, true, null],
  // Director pension (employer contribution).
  ['Director Pensions Base (£300 each PM)', 'expense', 600.00, true, null],
  // Wages — staff salaries & tax.
  ['Anna - part of B salary', 'wages', 1047.50, true, null],
  ['Ben', 'wages', 2113.50, true, null],
  ['Adam', 'wages', 3500.00, true, null],
  ['Director personal tax saving', 'wages', 950.00, true, null],
  ['Callum', 'wages', 2480.00, true, null],
  ['Callum commission', 'wages', 448.55, true, null],
  ['Chloe', 'wages', 800.00, true, null],
  ['Hannah Bales', 'wages', 2121.11, true, null],
  ['Adam Leveson', 'wages', 2121.11, true, null],
  // Freelancers.
  ['Lesley Ovington', 'freelancer', 1750.00, true, null],
  ['Freelance Copywriter', 'freelancer', 170.00, true, null],
  // Director allowances — June 2026 one-offs.
  ['Adam Director allowance', 'director', 250.00, false, '2026-06'],
  ['Ben Director allowance', 'director', 250.00, false, '2026-06'],
];

let cashflowEnsured = null;
function ensureCashflow() {
  if (cashflowEnsured) return cashflowEnsured;
  cashflowEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS cashflow_costs (
        id             TEXT PRIMARY KEY,
        label          TEXT NOT NULL,
        category       TEXT NOT NULL DEFAULT 'expense',
        amount         NUMERIC NOT NULL DEFAULT 0,
        recurring      BOOLEAN NOT NULL DEFAULT true,
        month          TEXT,
        effective_from TEXT,
        effective_to   TEXT,
        sort_order     INT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS cashflow_activity (
        id          BIGSERIAL PRIMARY KEY,
        actor_email TEXT,
        action      TEXT NOT NULL,
        summary     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`ALTER TABLE cashflow_costs ADD COLUMN IF NOT EXISTS frequency TEXT NOT NULL DEFAULT 'monthly'`;
    await sql`ALTER TABLE cashflow_costs ADD COLUMN IF NOT EXISTS note TEXT`;
    await sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS cashflow_profit_goal NUMERIC`;

    // Seed the cost base once (empty table only). Deterministic ids +
    // ON CONFLICT DO NOTHING so a concurrent cold-start re-seed can't duplicate.
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM cashflow_costs`;
    if (count === 0) {
      let i = 0;
      for (const [label, category, amount, recurring, month] of CASHFLOW_COST_SEED) {
        await sql`
          INSERT INTO cashflow_costs (id, label, category, amount, recurring, month, effective_from, sort_order)
          VALUES (${'cfseed' + i}, ${label}, ${category}, ${amount}, ${recurring}, ${month}, ${null}, ${i})
          ON CONFLICT (id) DO NOTHING`;
        i += 1;
      }
    }

    // One-time move of the seeded freelancers (Lesley + Freelance Copywriter)
    // from wages into their own category, added after the original seed. Runs
    // only until a freelancer row exists, so it never clobbers later manual
    // recategorisation.
    const [{ fcount }] = await sql`SELECT COUNT(*)::int AS fcount FROM cashflow_costs WHERE category = 'freelancer'`;
    if (fcount === 0) {
      await sql`UPDATE cashflow_costs SET category = 'freelancer' WHERE id IN ('cfseed42', 'cfseed43') AND category = 'wages'`;
    }
    // Likewise, move the seeded marketing lines (PPC + Sophie) out of expenses.
    const [{ mcount }] = await sql`SELECT COUNT(*)::int AS mcount FROM cashflow_costs WHERE category = 'marketing'`;
    if (mcount === 0) {
      await sql`UPDATE cashflow_costs SET category = 'marketing' WHERE id IN ('cfseed30', 'cfseed31') AND category = 'expense'`;
    }
    // And the seeded director allowances into their own category.
    const [{ dcount }] = await sql`SELECT COUNT(*)::int AS dcount FROM cashflow_costs WHERE category = 'director'`;
    if (dcount === 0) {
      await sql`UPDATE cashflow_costs SET category = 'director' WHERE id IN ('cfseed44', 'cfseed45') AND category = 'expense'`;
    }
  })().catch((err) => { cashflowEnsured = null; throw err; });
  return cashflowEnsured;
}

const gbp = (n) => '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const curMonthKey = () => monthKey(new Date());

async function logCashflow(actorEmail, action, summary) {
  try {
    await sql`INSERT INTO cashflow_activity (actor_email, action, summary) VALUES (${actorEmail || null}, ${action}, ${summary})`;
  } catch { /* non-fatal — the feed is a nicety, not a gate */ }
}

// An annual cost is entered as a yearly figure; its monthly-equivalent (÷12) is
// what feeds every profit/CT calculation. Monthly costs pass straight through.
function monthlyAmountOf(r) {
  const amt = Number(r.amount) || 0;
  return r.frequency === 'annual' ? amt / 12 : amt;
}

// Cost categories: staff wages, freelancers, marketing, director allowances and
// operating expenses. Anything unrecognised falls back to 'expense'.
const CATEGORIES = ['wages', 'freelancer', 'marketing', 'director'];
const normCategory = (c) => (CATEGORIES.includes(c) ? c : 'expense');

function serialiseCost(r) {
  const frequency = r.frequency === 'annual' ? 'annual' : 'monthly';
  return {
    id: r.id,
    label: r.label,
    category: normCategory(r.category),
    amount: Number(r.amount) || 0,
    frequency,
    monthlyAmount: round2(monthlyAmountOf(r)),
    note: r.note || null,
    recurring: r.recurring !== false,
    month: r.month || null,
    effectiveFrom: r.effective_from || null,
    effectiveTo: r.effective_to || null,
  };
}

// Does a cost row contribute to month `mk` ('YYYY-MM')? One-offs hit their own
// month; recurring costs apply across their effective window (open-ended both ends).
function costAppliesToMonth(r, mk) {
  if (r.recurring === false) return (r.month || null) === mk;
  if (r.effective_from && mk < r.effective_from) return false;
  if (r.effective_to && mk > r.effective_to) return false;
  return true;
}

// HMRC Corporation Tax with marginal relief (no associated companies / no
// distributions): 19% up to £50k, 25% over £250k, tapered between. At £50k this
// returns 19%, at £250k exactly 25% — matching gov.uk's marginal-relief figures.
const CT_LOWER = 50000, CT_UPPER = 250000, CT_MAIN = 0.25, CT_SMALL = 0.19, CT_MR_FRACTION = 3 / 200;
function corpTaxOn(profit) {
  const p = Math.max(0, Number(profit) || 0);
  if (p <= CT_LOWER) return p * CT_SMALL;
  if (p >= CT_UPPER) return p * CT_MAIN;
  return p * CT_MAIN - CT_MR_FRACTION * (CT_UPPER - p);
}

// Cash Flow report for a month ('YYYY-MM', default current). Profit is on a CASH
// basis: net cash received that month − costs (wages + expenses). The CT reserve
// uses the blended marginal rate from the trailing-12-month profit so it tracks
// what you'll actually owe; a loss month shows a negative reserve (a CT saving).
async function cashflowReport(action) {
  await ensureCashflow();
  const month = /^\d{4}-\d{2}$/.test(action || '') ? action : curMonthKey();
  const [my, mm] = month.split('-').map(Number); // mm is 1-based

  // Trailing 12 months ending at (and including) the selected month.
  const keys = [];
  for (let i = 11; i >= 0; i--) keys.push(monthKey(new Date(Date.UTC(my, mm - 1 - i, 1))));
  const since = new Date(Date.UTC(my, mm - 12, 1)).toISOString();
  const until = new Date(Date.UTC(my, mm, 1)).toISOString(); // start of the month after the selected one

  // Net cash received per month across the window.
  const paidRows = await fetchPaidRows(since, until);
  const cashByMonth = {};
  for (const k of keys) cashByMonth[k] = 0;
  for (const r of paidRows) { const k = monthKey(r.paidAt); if (k in cashByMonth) cashByMonth[k] += r.net; }

  // Pre-CRM months have no payment rows, so splice in the imported Live Sales
  // Sheet "Sales (cash in)" figures (the same source the Sales vs PP's chart
  // uses) for every PAST month. The current calendar month is never overridden —
  // it always reflects live CRM cash so today's figure stays accurate.
  const overrides = await fetchHistoryOverrides(keys);
  const nowKey = monthKey(new Date());
  const cashInFor = (mk) => {
    const ov = overrides.get(mk);
    return (ov && mk !== nowKey) ? ov.sales : (cashByMonth[mk] || 0);
  };

  // Actual monthly operating costs from Xero (Cost of Sales + Operating Expenses)
  // for PAST months — the current month always keeps the hand-built cost base.
  // Best-effort: if Xero isn't connected with the reports scope, fall back to base.
  let xeroCosts = new Map();
  try {
    xeroCosts = await getMonthlyOperatingCosts({ endMonth: month });
  } catch (err) {
    console.error('[cashflow] Xero P&L unavailable', err?.message || err);
  }

  // Costs (resolved per month from the recurring + one-off rows).
  const costRows = await sql`SELECT * FROM cashflow_costs ORDER BY sort_order ASC NULLS LAST, created_at ASC`;
  const costsForMonth = (mk) => {
    let wages = 0, expenses = 0, freelancers = 0, marketing = 0, director = 0;
    for (const r of costRows) {
      if (!costAppliesToMonth(r, mk)) continue;
      const amt = monthlyAmountOf(r);
      const cat = normCategory(r.category);
      if (cat === 'wages') wages += amt;
      else if (cat === 'freelancer') freelancers += amt;
      else if (cat === 'marketing') marketing += amt;
      else if (cat === 'director') director += amt;
      else expenses += amt;
    }
    return { wages: round2(wages), expenses: round2(expenses), freelancers: round2(freelancers), marketing: round2(marketing), director: round2(director), total: round2(wages + expenses + freelancers + marketing + director) };
  };

  const history = keys.map((mk) => {
    const c = costsForMonth(mk);
    const cashIn = round2(cashInFor(mk));
    const xc = xeroCosts.get(mk);
    const useXero = mk !== nowKey && xc != null;
    const costs = useXero ? round2(xc) : c.total;
    return {
      month: mk, cashIn,
      wages: c.wages, expenses: c.expenses, freelancers: c.freelancers, marketing: c.marketing, director: c.director,
      costs, costSource: useXero ? 'xero' : 'base',
      profit: round2(cashIn - costs),
    };
  });

  const profit12 = round2(history.reduce((s, h) => s + h.profit, 0));
  const cashIn12 = round2(history.reduce((s, h) => s + h.cashIn, 0));
  const costs12 = round2(history.reduce((s, h) => s + h.costs, 0));
  const ctYear = round2(corpTaxOn(profit12));
  const effectiveRate = profit12 > 0 ? ctYear / profit12 : 0;

  const sel = history[history.length - 1];
  const monthReserve = round2(sel.profit * effectiveRate); // negative on a loss month = a CT saving

  const [{ pg }] = await sql`SELECT COALESCE(cashflow_profit_goal, 0) AS pg FROM settings WHERE id = 1`;
  const profitGoal = round2(Number(pg) || 0);

  const lines = costRows.filter((r) => costAppliesToMonth(r, month)).map(serialiseCost);
  const activityRows = await sql`SELECT id, actor_email, action, summary, created_at FROM cashflow_activity ORDER BY created_at DESC LIMIT 40`;

  return {
    month,
    selected: sel,
    corpTax: { effectiveRate, monthReserve, yearEstimate: ctYear, profit12, cashIn12, costs12, inProfit: sel.profit > 0 },
    suggested: { profitGoal, breakEven: sel.costs, target: round2(sel.costs + profitGoal) },
    history,
    lines,
    activity: activityRows.map((r) => ({ id: String(r.id), actor: r.actor_email || null, action: r.action, summary: r.summary, createdAt: r.created_at })),
  };
}

// Writes for the Cash Flow tab. action carries the cost id for PATCH/DELETE.
//   POST { profitGoal }                          → set the monthly profit goal
//   POST { label, category, amount, recurring, month?, effectiveFrom? } → add a cost
//   PATCH/<id> { label?, category?, amount?, effectiveTo? }            → edit a cost
//   DELETE/<id>                                  → remove a cost
async function cashflowRoute(req, res, action, user) {
  await ensureCashflow();
  const actor = (user?.email || '').toLowerCase();

  if (req.method === 'POST' || req.method === 'PUT') {
    const body = req.body || {};
    if ('profitGoal' in body) {
      const pg = Number(body.profitGoal) || 0;
      await sql`UPDATE settings SET cashflow_profit_goal = ${pg} WHERE id = 1`;
      await logCashflow(actor, 'goal.update', `Set monthly profit goal to ${gbp(pg)}`);
      return res.status(200).json({ ok: true });
    }
    // Drag-reorder: persist the given category's ids in their new order.
    if (Array.isArray(body.reorder)) {
      let i = 0;
      for (const cid of body.reorder) {
        if (typeof cid !== 'string') continue;
        await sql`UPDATE cashflow_costs SET sort_order = ${i}, updated_at = NOW() WHERE id = ${cid}`;
        i += 1;
      }
      return res.status(200).json({ ok: true });
    }
    const label = trimOrNull(body.label);
    if (!label) return res.status(400).json({ error: 'label required' });
    const category = normCategory(body.category);
    const frequency = body.frequency === 'annual' ? 'annual' : 'monthly';
    const amount = Number(body.amount) || 0;
    const note = trimOrNull(body.note);
    const recurring = body.recurring !== false;
    const month = recurring ? null : (trimOrNull(body.month) || curMonthKey());
    const effectiveFrom = recurring ? (trimOrNull(body.effectiveFrom) || curMonthKey()) : null;
    const id = makeId('cf');
    const [{ m }] = await sql`SELECT COALESCE(MAX(sort_order), -1) AS m FROM cashflow_costs`;
    await sql`
      INSERT INTO cashflow_costs (id, label, category, amount, frequency, note, recurring, month, effective_from, sort_order)
      VALUES (${id}, ${label}, ${category}, ${amount}, ${frequency}, ${note}, ${recurring}, ${month}, ${effectiveFrom}, ${m + 1})`;
    const kindWord = category === 'wages' ? 'wage' : category === 'freelancer' ? 'freelancer' : category === 'marketing' ? 'marketing cost' : category === 'director' ? 'director allowance' : 'expense';
    const amtWord = frequency === 'annual' ? `${gbp(amount)}/yr (≈${gbp(amount / 12)}/mo)` : `${gbp(amount)}/mo`;
    await logCashflow(actor, 'cost.add', recurring
      ? `Added recurring ${kindWord} “${label}” ${amtWord}`
      : `Added one-off ${kindWord} “${label}” ${gbp(amount)} (${month})`);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'PATCH') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    // Reorder within a category — swap sort_order with the adjacent same-category row.
    if (body.move === 'up' || body.move === 'down') {
      const [row] = await sql`SELECT id, category, sort_order FROM cashflow_costs WHERE id = ${action}`;
      if (!row) return res.status(404).json({ error: 'Not found' });
      const so = row.sort_order;
      const neighbour = body.move === 'up'
        ? (await sql`SELECT id, sort_order FROM cashflow_costs WHERE category = ${row.category} AND sort_order < ${so} ORDER BY sort_order DESC NULLS LAST LIMIT 1`)[0]
        : (await sql`SELECT id, sort_order FROM cashflow_costs WHERE category = ${row.category} AND sort_order > ${so} ORDER BY sort_order ASC LIMIT 1`)[0];
      if (!neighbour) return res.status(200).json({ ok: true }); // already at the end
      await sql`UPDATE cashflow_costs SET sort_order = ${neighbour.sort_order} WHERE id = ${row.id}`;
      await sql`UPDATE cashflow_costs SET sort_order = ${so} WHERE id = ${neighbour.id}`;
      return res.status(200).json({ ok: true });
    }
    const [existing] = await sql`SELECT * FROM cashflow_costs WHERE id = ${action}`;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const label = body.label !== undefined ? (trimOrNull(body.label) || existing.label) : existing.label;
    const category = body.category !== undefined ? normCategory(body.category) : existing.category;
    const frequency = body.frequency !== undefined ? (body.frequency === 'annual' ? 'annual' : 'monthly') : (existing.frequency || 'monthly');
    const amount = body.amount !== undefined ? (Number(body.amount) || 0) : existing.amount;
    const note = body.note !== undefined ? trimOrNull(body.note) : existing.note;
    const effectiveTo = body.effectiveTo !== undefined ? trimOrNull(body.effectiveTo) : existing.effective_to;
    await sql`
      UPDATE cashflow_costs
         SET label = ${label}, category = ${category}, amount = ${amount}, frequency = ${frequency}, note = ${note}, effective_to = ${effectiveTo}, updated_at = NOW()
       WHERE id = ${action}`;
    const upWord = frequency === 'annual' ? `${gbp(Number(amount) || 0)}/yr` : gbp(Number(amount) || 0);
    await logCashflow(actor, 'cost.update', `Updated “${label}” to ${upWord}`);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const [existing] = await sql`SELECT label, amount FROM cashflow_costs WHERE id = ${action}`;
    await sql`DELETE FROM cashflow_costs WHERE id = ${action}`;
    if (existing) await logCashflow(actor, 'cost.delete', `Removed “${existing.label}” ${gbp(Number(existing.amount) || 0)}`);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export async function statsRoute(req, res, id, action, user) {
  // Live financial figures — never let a browser/edge serve a stale copy (e.g.
  // showing an extra that's since been deleted, or yesterday's cash position).
  res.setHeader('Cache-Control', 'no-store');

  // Reference data — any authenticated user may read it (no business figures).
  if (id === 'bank-holidays') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return res.status(200).json({ dates: await bankHolidaysEW() });
  }

  // Whole-business finances — owner/admin only.
  if (!hasPermission(await getRole(user.role), 'settings.manage')) {
    return res.status(403).json({ error: 'You do not have permission to view business finances' });
  }

  // Writable stats resources: the sales-sheet history + manual pending payments.
  if (id === 'history') {
    return historyRoute(req, res);
  }
  if (id === 'pending-manual') {
    return pendingManualRoute(req, res, action);
  }
  if (id === 'linkable-deals') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return res.status(200).json({ deals: await linkableDeals() });
  }
  if (id === 'income-date') {
    return incomeDateRoute(req, res);
  }
  if (id === 'cashflow-cost') {
    return cashflowRoute(req, res, action, user);
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (id === 'trend') {
    return res.status(200).json(await trendReport(action));
  }

  if (id === 'finance') {
    const year = parseInt(action, 10) || new Date().getUTCFullYear();
    return res.status(200).json(await financeReport(year));
  }

  if (id === 'performance') {
    return res.status(200).json(await performanceReport(action));
  }

  if (id === 'sales') {
    return res.status(200).json(await salesReport(action));
  }

  if (id === 'sales-finance') {
    const year = parseInt(action, 10) || new Date().getUTCFullYear();
    return res.status(200).json(await salesFinanceReport(year));
  }

  if (id === 'sales-ledger') {
    return res.status(200).json(await salesLedgerReport(action));
  }

  if (id === 'pending') {
    return res.status(200).json(await pendingPaymentsReport());
  }

  if (id === 'income') {
    return res.status(200).json(await incomeReport(action));
  }

  if (id === 'cashflow') {
    return res.status(200).json(await cashflowReport(action));
  }

  return res.status(404).json({ error: 'Unknown stats report' });
}
