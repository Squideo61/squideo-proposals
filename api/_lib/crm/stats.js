import crypto from 'node:crypto';
import { put, del, get as blobGet } from '@vercel/blob';
import sql from '../db.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';
import { makeId, trimOrNull, numberOrNull } from './shared.js';
import { allCompanyBalances } from './companies.js';
import { outstandingExtrasByDeal, ensureDealExtrasTable } from './extras.js';
import { reconcileProposalBillingPaid, ensureInvoiceExcludeColumn } from './invoices.js';
import { archiveRecord } from './recycleBin.js';
import { sendNotification } from '../notifications.js';
import { ensureDealPo } from './deals.js';
import { commissionTotalsForMonths, commissionByMemberForMonth } from './commission.js';
import { zipStore } from '../zip.js';

// Business finance/performance aggregates across ALL customers. Unions the same
// five paid-money sources as companies.js (allCompanyBalances /
// computeCompanyLifetime) so the headline totals reconcile with the per-company
// pages. Read-only; gated behind finance.manage (whole-business figures).
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
    // A row can instead be linked to a customer (company) directly — used for
    // one-off imported items that belong to a client but not a specific deal.
    await sql`ALTER TABLE manual_pending_payments ADD COLUMN IF NOT EXISTS company_id TEXT`;
    // Archived rows drop off the outstanding list but stay retrievable (distinct
    // from Remove, which hard-deletes into the recycle bin).
    await sql`ALTER TABLE manual_pending_payments ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`;

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

// "Other" recurring revenue — small ongoing monthly income outside CRM deals and
// the Partner Programme (e.g. web hosting). [label, note, amountExVat, vat].
// Seeded once into an empty table; after that the in-app add/edit/remove is the
// source of truth. Each is a flat monthly net + VAT, like a Partner subscription.
const RECURRING_OTHER_SEED = [
  ['Dip-san - McAllen Innovations', 'Website Hosting + Shopify', 50.00, 10.00],
  ['Anderson 121withtom', 'Website hosting', 12.99, 2.60],
];

let recurringOtherEnsured = null;
function ensureRecurringOther() {
  if (recurringOtherEnsured) return recurringOtherEnsured;
  recurringOtherEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS recurring_other_revenue (
        id             TEXT PRIMARY KEY,
        label          TEXT NOT NULL,
        note           TEXT,
        amount_ex_vat  NUMERIC NOT NULL DEFAULT 0,
        vat            NUMERIC NOT NULL DEFAULT 0,
        sort_order     INT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    // Seed deterministic ids + ON CONFLICT DO NOTHING so a concurrent re-seed can
    // never duplicate (the second insert hits the same PK).
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM recurring_other_revenue`;
    if (count === 0) {
      let i = 0;
      for (const [label, note, amount, vat] of RECURRING_OTHER_SEED) {
        await sql`
          INSERT INTO recurring_other_revenue (id, label, note, amount_ex_vat, vat, sort_order)
          VALUES (${'seedother' + i}, ${label}, ${note || null}, ${amount}, ${vat}, ${i})
          ON CONFLICT (id) DO NOTHING`;
        i += 1;
      }
    }
  })().catch((err) => { recurringOtherEnsured = null; throw err; });
  return recurringOtherEnsured;
}

function serialiseOther(r) {
  return {
    id: r.id,
    label: r.label || null,
    note: r.note || null,
    amountExVat: Number(r.amount_ex_vat) || 0,
    vat: Number(r.vat) || 0,
  };
}

// A recurring line, once its GoCardless (or any) payment lands, is marked
// "received" for a month here — that turns it into actual banked income for that
// month (fetchPaidRows / incomeReport read it), while the recurring_other_revenue
// row stays the ongoing monthly template. net/vat are snapshotted at mark-time so
// later editing the template doesn't rewrite history. One payment per (line, month).
let recurringOtherPaymentsEnsured = null;
function ensureRecurringOtherPayments() {
  if (recurringOtherPaymentsEnsured) return recurringOtherPaymentsEnsured;
  recurringOtherPaymentsEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS recurring_other_payments (
        id            TEXT PRIMARY KEY,
        recurring_id  TEXT NOT NULL,
        month         TEXT NOT NULL,
        net           NUMERIC NOT NULL DEFAULT 0,
        vat           NUMERIC NOT NULL DEFAULT 0,
        paid_at       TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS recurring_other_payments_uniq ON recurring_other_payments (recurring_id, month)`;
  })().catch((err) => { recurringOtherPaymentsEnsured = null; throw err; });
  return recurringOtherPaymentsEnsured;
}

// Recurring payments received in [sinceISO, untilISO) — banked income, labelled by
// the template's customer name. Robust to a missing table → [].
async function fetchPaidRecurringOther(sinceISO, untilISO) {
  try {
    await ensureRecurringOtherPayments();
    return await sql`
      SELECT rop.id AS edit_key, rop.paid_at, rop.net, rop.vat, ro.label AS company
        FROM recurring_other_payments rop
        LEFT JOIN recurring_other_revenue ro ON ro.id = rop.recurring_id
       WHERE rop.paid_at >= ${sinceISO} AND rop.paid_at < ${untilISO}`;
  } catch {
    return [];
  }
}

// Recurring "Other" revenue rows (robust to a missing table → []). Each row also
// carries `receivedMonths` — the 'YYYY-MM' months already banked — so the UI can
// show which months are logged and offer an undo.
async function fetchRecurringOther() {
  try {
    await ensureRecurringOther();
    const rows = await sql`
      SELECT * FROM recurring_other_revenue
       ORDER BY sort_order ASC NULLS LAST, created_at ASC`;
    let paid = [];
    try {
      await ensureRecurringOtherPayments();
      paid = await sql`SELECT recurring_id, month FROM recurring_other_payments`;
    } catch { /* payments table not created yet — no months received */ }
    const byId = {};
    for (const p of paid) (byId[p.recurring_id] = byId[p.recurring_id] || []).push(p.month);
    return rows.map((r) => ({ ...serialiseOther(r), receivedMonths: byId[r.id] || [] }));
  } catch {
    return [];
  }
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
    companyId: r.company_id || null,
    linkedCompanyName: r.linked_company_name || null,
    archived: r.archived === true,
  };
}

// Outstanding (unpaid) manual pending payments (robust to a missing table → []).
// Pass { archived: true } for the archive view — otherwise archived rows are
// hidden from the live outstanding list.
async function fetchManualPending({ archived = false } = {}) {
  try {
    await ensureManualPendingPayments();
    const rows = archived
      ? await sql`
          SELECT m.*, c.name AS linked_company_name
            FROM manual_pending_payments m
            LEFT JOIN companies c ON c.id = m.company_id
           WHERE m.status <> 'paid' AND m.archived = true
           ORDER BY m.sort_order ASC NULLS LAST, m.created_at ASC`
      : await sql`
          SELECT m.*, c.name AS linked_company_name
            FROM manual_pending_payments m
            LEFT JOIN companies c ON c.id = m.company_id
           WHERE m.status <> 'paid' AND m.archived = false
           ORDER BY m.sort_order ASC NULLS LAST, m.created_at ASC`;
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
      sql`SELECT id, company, amount_ex_vat FROM manual_pending_payments WHERE status <> 'paid' AND deal_id IS NULL AND company_id IS NULL`,
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

// Partner subscription fees marked paid (the "Mark paid" button on Partners &
// Credits) in [sinceISO, untilISO) — labelled by the partner's name. These already
// hit NET REVENUE via fetchPaidRows; this surfaces them in the itemised ledger too.
// Guarded: partner_fee_payments is created by the partner route's self-heal.
async function fetchPaidPartnerFees(sinceISO, untilISO) {
  try {
    return await sql`
      SELECT pfp.id AS edit_key, pfp.paid_at, pfp.net, pfp.vat, pfp.method,
             (SELECT ps.client_name FROM partner_subscriptions ps
               WHERE ps.client_key = pfp.client_key
               ORDER BY ps.created_at DESC LIMIT 1) AS company
        FROM partner_fee_payments pfp
       WHERE pfp.paid_at >= ${sinceISO} AND pfp.paid_at < ${untilISO}`;
  } catch {
    return [];
  }
}

// Every paid-money row across all customers with paid_at in [sinceISO, untilISO).
// Returns [{ paidAt: Date, net, vat, gross, proposalId, ownerEmail, dealId }].
// Dates are bucketed in UTC. ownerEmail/dealId carry the deal's sales owner (via
// proposal→deal, or the manual invoice's own deal_id); they're null for
// proposal-less sources (imported PPs, partner fees, recurring "Other") and are
// ignored by callers that only read net/vat/gross/paidAt.
export async function fetchPaidRows(sinceISO, untilISO) {
  const [stripeR, partnerR, manualR, invR, pbR] = await Promise.all([
    sql`SELECT pay.amount AS inc, pay.paid_at, pr.data->>'vatRate' AS rate, pr.id AS proposal_id,
               d.owner_email, d.id AS deal_id
          FROM payments pay JOIN proposals pr ON pr.id = pay.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
         WHERE pay.paid_at >= ${sinceISO} AND pay.paid_at < ${untilISO}`,
    sql`SELECT pi.amount AS inc, pi.paid_at, pr.data->>'vatRate' AS rate, pr.id AS proposal_id,
               d.owner_email, d.id AS deal_id
          FROM partner_invoices pi JOIN proposals pr ON pr.id = pi.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
         WHERE pi.paid_at >= ${sinceISO} AND pi.paid_at < ${untilISO}`,
    sql`SELECT mp.amount AS inc, mp.paid_at, pr.data->>'vatRate' AS rate, pr.id AS proposal_id,
               d.owner_email, d.id AS deal_id
          FROM manual_payments mp JOIN proposals pr ON pr.id = mp.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
         WHERE mp.manual_invoice_id IS NULL
           AND mp.paid_at >= ${sinceISO} AND mp.paid_at < ${untilISO}`,
    sql`SELECT mi.amount AS inc, mi.paid_at, mi.subtotal_ex_vat, mi.tax_amount,
               pr.data->>'vatRate' AS rate, pr.id AS proposal_id,
               d.owner_email, d.id AS deal_id
          FROM manual_invoices mi
          LEFT JOIN proposals pr ON pr.id = mi.proposal_id
          LEFT JOIN deals d ON d.id = COALESCE(mi.deal_id, pr.deal_id)
         WHERE mi.status = 'paid'
           AND mi.paid_at >= ${sinceISO} AND mi.paid_at < ${untilISO}`,
    sql`SELECT pb.paid_amount AS inc, pb.paid_at, pr.data->>'vatRate' AS rate, pr.id AS proposal_id,
               d.owner_email, d.id AS deal_id
          FROM proposal_billing pb JOIN proposals pr ON pr.id = pb.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
         WHERE pb.paid_amount IS NOT NULL
           AND pb.paid_at >= ${sinceISO} AND pb.paid_at < ${untilISO}`,
  ]);

  const rows = [];
  const push = (paidAt, parts, proposalId = null, ownerEmail = null, dealId = null) => {
    if (paidAt) rows.push({ paidAt: new Date(paidAt), proposalId: proposalId || null, ownerEmail: ownerEmail || null, dealId: dealId || null, ...parts });
  };

  for (const r of stripeR) push(r.paid_at, splitVat(r.inc, r.rate), r.proposal_id, r.owner_email, r.deal_id);
  for (const r of partnerR) push(r.paid_at, splitVat(r.inc, r.rate), r.proposal_id, r.owner_email, r.deal_id);
  for (const r of manualR) push(r.paid_at, splitVat(r.inc, r.rate), r.proposal_id, r.owner_email, r.deal_id);
  for (const r of invR) {
    // Prefer the invoice's own stored VAT breakdown (most accurate, incl.
    // company-level invoices with no linked proposal); fall back to the linked
    // proposal's rate; else treat as zero-rated.
    const gross = Number(r.inc) || 0;
    if (r.subtotal_ex_vat != null || r.tax_amount != null) {
      const net = r.subtotal_ex_vat != null ? Number(r.subtotal_ex_vat) : gross - (Number(r.tax_amount) || 0);
      const vat = r.tax_amount != null ? Number(r.tax_amount) : gross - net;
      push(r.paid_at, { gross, net, vat }, r.proposal_id, r.owner_email, r.deal_id);
    } else {
      push(r.paid_at, splitVat(gross, r.rate), r.proposal_id, r.owner_email, r.deal_id);
    }
  }
  for (const r of pbR) push(r.paid_at, splitVat(r.inc, r.rate), r.proposal_id, r.owner_email, r.deal_id);

  // Manual pending payments marked paid — net + stored VAT.
  const ppPaid = await fetchPaidManualPps(sinceISO, untilISO);
  for (const r of ppPaid) {
    const net = Number(r.amount_ex_vat) || 0;
    const vat = Number(r.vat) || 0;
    push(r.paid_at, { net, vat, gross: net + vat });
  }

  // Partner fee months marked paid (manual partners) — net + VAT stored directly,
  // so they hit cash-in AND the VAT-to-save figure. Guarded: the table is created
  // by the partner route's self-heal, which may not have run on a fresh deploy.
  try {
    const partnerFeeRows = await sql`
      SELECT net, vat, paid_at FROM partner_fee_payments
       WHERE paid_at >= ${sinceISO} AND paid_at < ${untilISO}`;
    for (const r of partnerFeeRows) {
      const net = Number(r.net) || 0;
      const vat = Number(r.vat) || 0;
      push(r.paid_at, { net, vat, gross: net + vat });
    }
  } catch { /* partner_fee_payments not created yet — ignore */ }

  // Recurring "Other" revenue marked received this period (web hosting, GoCardless
  // subscriptions etc.) — banked net + stored VAT.
  const recPaid = await fetchPaidRecurringOther(sinceISO, untilISO);
  for (const r of recPaid) {
    const net = Number(r.net) || 0;
    const vat = Number(r.vat) || 0;
    push(r.paid_at, { net, vat, gross: net + vat });
  }

  return dedupePaymentRows(rows);
}

// Collapse rows that are the SAME payment recorded via two mechanisms — e.g. a
// proposal marked paid manually AND its Xero invoice reconciled, which would
// otherwise count twice in cash-in and the income ledger. The signature of a
// true duplicate is: same proposal, same day, same gross amount. When two
// collide we keep the more authoritative source (a real Stripe/Xero/invoice
// record over a hand-marked manual payment). Rows with no proposal (imported
// sheet PPs, ad-hoc/company invoices, partner fees) are always kept — they can't
// be matched to a proposal to dedupe against. A genuine 50/50 deposit + final
// differs by day, so it survives. Works for both row shapes (paidAt as a Date or
// an ISO string; `source` present or not).
const PAYMENT_SOURCE_PRIORITY = { stripe: 0, billing: 1, invoice: 2, partner: 3, manual: 4, sheet: 5 };
function dedupePaymentRows(rows) {
  const idxByKey = new Map();
  const out = [];
  for (const r of rows) {
    if (!r.proposalId) { out.push(r); continue; }
    const day = (r.paidAt instanceof Date ? r.paidAt.toISOString() : String(r.paidAt)).slice(0, 10);
    const key = `${r.proposalId}|${day}|${round2(r.gross)}`;
    if (!idxByKey.has(key)) { idxByKey.set(key, out.length); out.push(r); continue; }
    const i = idxByKey.get(key);
    const rp = PAYMENT_SOURCE_PRIORITY[r.source] ?? 9;
    const cp = PAYMENT_SOURCE_PRIORITY[out[i].source] ?? 9;
    if (rp < cp) out[i] = r; // replace with the more authoritative record
  }
  return out;
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
    month, net: round2(v.net), vat: round2(v.vat), gross: round2(v.gross), corpTax: 0,
  }));

  // Corporation Tax to set aside per month — on TAXABLE profit (cash banked net −
  // the CT-deductible cost base, which excludes director dividends and the
  // personal-tax line), each month annualised to pick the HMRC marginal band
  // (monthlyCorpTax) so a profitable month reserves CT regardless of empty earlier
  // months. A loss month reserves nothing. Mirrors the Cash Flow tab (estimate).
  try {
    const costRows = await loadCashflowCostRows();
    for (const m of months) {
      const tp = round2(m.net - deductibleCostTotalForMonth(costRows, m.month));
      m.corpTax = monthlyCorpTax(tp);
    }
  } catch { /* leave corpTax at 0 — the cost base is admin-only and may be empty */ }

  // YTD: whole year for a past year, else up to (and including) the current month.
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const ytd = { net: 0, vat: 0, gross: 0, corpTax: 0 };
  for (const m of months) {
    const mi = Number(m.month.slice(5)) - 1;
    if (year < curYear || (year === curYear && mi <= now.getUTCMonth())) {
      ytd.net += m.net; ytd.vat += m.vat; ytd.gross += m.gross; ytd.corpTax += m.corpTax;
    }
  }

  // Calendar quarters — UK VAT returns are filed quarterly, so a quarter roll-up
  // of the VAT-to-save (and CT to set aside) is handy alongside the monthly view.
  const quarters = [0, 1, 2, 3].map((q) => {
    const qm = months.slice(q * 3, q * 3 + 3);
    return {
      label: `Q${q + 1} ${year}`,
      net: round2(qm.reduce((s, x) => s + x.net, 0)),
      vat: round2(qm.reduce((s, x) => s + x.vat, 0)),
      gross: round2(qm.reduce((s, x) => s + x.gross, 0)),
      corpTax: round2(qm.reduce((s, x) => s + x.corpTax, 0)),
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
    ytd: { net: round2(ytd.net), vat: round2(ytd.vat), gross: round2(ytd.gross), corpTax: round2(ytd.corpTax) },
    quarters,
    outstanding: round2(outstanding),
  };
}

// Quarter roll-up of VAT + Corporation Tax to set aside (cash basis), for the
// quarterly-summary cron. qNum is 1-4. Reuses the finance report.
export async function quarterTaxSummary(year, qNum) {
  const fin = await financeReport(year);
  const q = (fin.quarters || [])[qNum - 1] || { label: `Q${qNum} ${year}`, net: 0, vat: 0, gross: 0, corpTax: 0 };
  const months = (fin.months || []).slice((qNum - 1) * 3, (qNum - 1) * 3 + 3);
  return { label: `Q${qNum} ${year}`, year, quarter: qNum, net: q.net, vat: q.vat, corpTax: q.corpTax || 0, gross: q.gross, months };
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

// Sales performance: new business *signed* in the period, valued at the net
// (ex-VAT) total — "the cash each sale generates" — bucketed by day. This is the
// "signed so far" pace headline (Sales-performance tab + Business Overview), so
// it counts genuinely-signed business only: signed proposals (by signature date)
// and ad-hoc extras added to signed deals (by created date). Standalone ad-hoc
// invoices with no signed proposal are deliberately NOT counted here — they're a
// raised invoice, not a signing — even though salesFinanceReport (the Finance
// "cash generated" card + trend) still includes them. `count` is the number of
// sale events that day.
async function salesReport(action) {
  const { period, spanMonths, since, until } = parsePerformancePeriod(action);
  const [sigRows, extraRows] = await Promise.all([
    sql`
      SELECT s.signed_at, (s.data->>'total')::numeric AS total, pr.data->>'vatRate' AS rate
        FROM signatures s
        JOIN proposals pr ON pr.id = s.proposal_id
       WHERE s.signed_at >= ${since} AND s.signed_at < ${until}
         AND (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'
    `,
    fetchExtraRows(since, until, false),
  ]);

  const byDay = {};
  const add = (dateVal, net) => {
    if (!dateVal) return;
    const k = dayKey(new Date(dateVal));
    if (!byDay[k]) byDay[k] = { net: 0, count: 0 };
    byDay[k].net += net;
    byDay[k].count += 1;
  };
  for (const r of sigRows) add(r.signed_at, splitVat(r.total, r.rate).net);
  for (const r of extraRows) add(r.created_at, extraSplit(r.amount, r.vat_rate).net);

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

// Standalone ad-hoc invoices (issued or paid) in [since, until): manual invoices
// whose effective deal has NO signed proposal — so they represent a sale the CRM
// wouldn't otherwise know about (a signed deal's value is counted by signature,
// and its deposit/final invoices must NOT double-count). Bucketed by issue date.
// Used by the sales reports + trend so an invoice raised without a proposal still
// counts as sales. Invoices an admin has flagged `exclude_from_stats` (e.g. a
// legacy debt, not new business) are dropped unless `includeExcluded` is set —
// the ledger passes it so it can list them separately with a re-include toggle.
// Robust to the table not existing → [].
async function fetchStandaloneInvoiceRows(since, until, includeExcluded = false) {
  try {
    await ensureInvoiceExcludeColumn();
    return await sql`
      SELECT mi.id, mi.invoice_number, mi.amount, mi.subtotal_ex_vat, mi.tax_amount,
             mi.status, COALESCE(mi.exclude_from_stats, false) AS exclude_from_stats,
             COALESCE(mi.issued_at, mi.created_at) AS at,
             COALESCE(mi.deal_id, pr.deal_id) AS deal_id,
             COALESCE(c.name, ddc.name, dpc.name) AS company
        FROM manual_invoices mi
        LEFT JOIN proposals pr  ON pr.id  = mi.proposal_id
        LEFT JOIN deals dd      ON dd.id  = mi.deal_id
        LEFT JOIN deals dp      ON dp.id  = pr.deal_id
        LEFT JOIN companies c   ON c.id   = mi.company_id
        LEFT JOIN companies ddc ON ddc.id = dd.company_id
        LEFT JOIN companies dpc ON dpc.id = dp.company_id
       WHERE mi.status IN ('issued', 'paid')
         AND (${includeExcluded} OR NOT COALESCE(mi.exclude_from_stats, false))
         AND COALESCE(mi.issued_at, mi.created_at) >= ${since}
         AND COALESCE(mi.issued_at, mi.created_at) <  ${until}
         AND NOT EXISTS (
           SELECT 1 FROM signatures s
             JOIN proposals p2 ON p2.id = s.proposal_id
            WHERE p2.deal_id = COALESCE(mi.deal_id, pr.deal_id)
              AND (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'
         )`;
  } catch {
    return [];
  }
}

// Net/VAT/gross for a standalone-invoice row: prefer the stored ex-VAT subtotal +
// tax, else treat `amount` as gross with no VAT split available.
function invoiceSplit(r) {
  const gross = Number(r.amount) || 0;
  const net = r.subtotal_ex_vat != null ? Number(r.subtotal_ex_vat) : gross;
  const vat = r.tax_amount != null ? Number(r.tax_amount) : Math.max(0, gross - net);
  return { net: round2(net), vat: round2(vat), gross: round2(net + vat) };
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
  // Ad-hoc invoices with no signed proposal — a sale the CRM only knows about via
  // the invoice. Bucketed by issue date so they show on the Sales bar/cards.
  const invRows = await fetchStandaloneInvoiceRows(since, until);
  for (const r of invRows) {
    if (!r.at) continue;
    const b = monthsMap[monthKey(new Date(r.at))];
    if (!b) continue;
    const { net, vat, gross } = invoiceSplit(r);
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
  // Ad-hoc invoices with no signed proposal — counted as sales at their issue
  // date. Excluded ones are still listed (with `excluded: true`) so the ledger
  // can show them under a re-includable "excluded" section, but they don't count
  // toward the total or any other sales figure.
  const invRows = await fetchStandaloneInvoiceRows(since, until, true);
  for (const r of invRows) {
    if (!r.at) continue;
    const { net, vat, gross } = invoiceSplit(r);
    rows.push({
      at: new Date(r.at).toISOString(),
      net, vat, gross,
      source: 'invoice', label: r.invoice_number || 'Invoice',
      company: r.company || null,
      dealId: r.deal_id || null,
      number: null,
      invoiceId: r.id,
      excluded: !!r.exclude_from_stats,
    });
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const total = round2(rows.filter((r) => !r.excluded).reduce((s, r) => s + r.net, 0));
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

  // Ad-hoc invoices with no signed proposal — generated value at issue date, and
  // (while still unpaid) new money owed.
  const invRows = await fetchStandaloneInvoiceRows(since, until);
  for (const r of invRows) {
    if (!r.at) continue;
    const b = buckets[monthKey(new Date(r.at))];
    if (!b) continue;
    const { net } = invoiceSplit(r);
    b.cashGenerated += net;
    if (r.status !== 'paid') b.pps += net;
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
    SELECT d.id AS did, p.id AS pid, s.data->>'total' AS total, p.data->>'vatRate' AS rate,
           s.data->>'paymentOption' AS opt, p.number_year AS ny, p.number_seq AS ns
      FROM signatures s
      JOIN proposals p ON p.id = s.proposal_id
      JOIN deals d ON d.id = p.deal_id
     WHERE (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'
  `;
  if (!sigRows.length) {
    const manual = await fetchManualPending();
    const other = await fetchRecurringOther();
    const otherTotal = round2(other.reduce((s, x) => s + (Number(x.amountExVat) || 0), 0));
    const manualTotal = round2(manual.reduce((s, x) => s + (Number(x.amountExVat) || 0), 0));
    const manualInvoiced = round2(
      manual.filter((x) => x.status === 'invoiced').reduce((s, x) => s + (Number(x.amountExVat) || 0), 0),
    );
    // No signed CRM deals, so "not invoiced" is just the un-invoiced imports.
    const notInvoiced = round2(manualTotal - manualInvoiced);
    return { normal: [], po: [], manual, other, totals: { normal: 0, po: 0, manual: manualTotal, manualInvoiced, other: otherTotal, invoiced: manualInvoiced, notInvoiced } };
  }

  const committed = new Map(); // did -> inc-VAT signed total
  const rateByDeal = new Map(); // did -> max vatRate across its proposals
  const poByDeal = new Map(); // did -> on the PO route?
  const planByDeal = new Map(); // did -> '5050' | 'full' (the chosen payment plan)
  const numberByDeal = new Map(); // did -> { year, seq } of its earliest proposal
  const proposalIdByDeal = new Map(); // did -> earliest signed proposal id (for recording a payment)
  for (const r of sigRows) {
    committed.set(r.did, (committed.get(r.did) || 0) + (Number(r.total) || 0));
    rateByDeal.set(r.did, Math.max(rateByDeal.get(r.did) || 0, Number(r.rate) || 0));
    if (r.opt === 'po') poByDeal.set(r.did, true);
    else if (!planByDeal.has(r.did) && (r.opt === '5050' || r.opt === 'full')) planByDeal.set(r.did, r.opt);
    if (r.ny && r.ns) {
      const cur = numberByDeal.get(r.did);
      if (!cur || Number(r.ns) < cur.seq) {
        numberByDeal.set(r.did, { year: Number(r.ny), seq: Number(r.ns) });
        proposalIdByDeal.set(r.did, r.pid);
      }
    } else if (!proposalIdByDeal.has(r.did)) {
      proposalIdByDeal.set(r.did, r.pid);
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
  await ensureDealPo();
  const infoRows = await sql`
    SELECT d.id, d.title, d.stage, d.company_id, c.name AS company_name,
           d.po_number, d.po_received_at
      FROM deals d LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.id = ANY(${dealIds})
  `;
  const info = new Map(infoRows.map((r) => [r.id, r]));

  const normal = [];
  const po = [];
  for (const did of dealIds) {
    // Every signed deal with an outstanding balance is listed (PO and non-PO);
    // each line is tagged invoiced / not-invoiced so a not-yet-invoiced portion
    // (e.g. a 50% final) shows and can be invoiced from the list. The Live Sales
    // Sheet import is legacy now — the CRM deal is the source of truth.
    const isPo = !!poByDeal.get(did);
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
    // Gross (inc-VAT) outstanding the client actually pays — used to pre-fill a
    // direct "mark paid" against the signed deal. Extras are net £, grossed at
    // the deal's VAT rate.
    const extrasGross = round2(extrasNet * (1 + rate));
    const item = {
      dealId: did,
      proposalId: proposalIdByDeal.get(did) || null,
      number: numberByDeal.get(did) || null,
      title: inf.title || 'Untitled deal',
      company: inf.company_name || null,
      companyId: inf.company_id || null,
      stage: inf.stage || null,
      committed: round2(net(inc) + extrasNet),
      paid: net(paidInc),
      outstanding: round2(outstandingNet + extrasNet),
      outstandingGross: round2(outstandingInc + extrasGross),
      lines,
      // PO tracking. PO-route deals show a "Pending PO" pill until poReceivedAt
      // is set, then "PO <number>". Any other deal can also have a PO uploaded
      // against it (from the deal's Invoices & Payments card), so these are
      // carried regardless of route — the UI shows the green pill whenever a PO
      // has been received.
      poNumber: inf.po_number || null,
      poReceivedAt: inf.po_received_at || null,
    };
    (isPo ? po : normal).push(item);
  }
  const byOutstanding = (a, b) => b.outstanding - a.outstanding;
  normal.sort(byOutstanding);
  po.sort(byOutstanding);
  const sum = (arr) => round2(arr.reduce((s, x) => s + x.outstanding, 0));

  // Ad-hoc / manual invoices issued-but-unpaid that AREN'T already covered by a
  // signed-deal row above: a company-level invoice (no deal), or an invoice raised
  // on a deal that has no signed proposal (so it never appears in normal/po). Both
  // are invoiced & awaiting payment; shaped like an imported invoiced row so they
  // sit in the same Invoiced list, tagged 'company-invoice'. The NOT EXISTS guard
  // means an invoice on a *signed* deal is left to the deal's own row (no
  // double-count). Company/deal links are surfaced so the row opens its deal.
  const companyInvRows = await sql`
    SELECT mi.id, mi.invoice_number, mi.amount, mi.subtotal_ex_vat, mi.tax_amount,
           COALESCE(mi.deal_id, pr.deal_id) AS deal_id,
           COALESCE(mi.company_id, dd.company_id, dp.company_id) AS company_id,
           COALESCE(c.name, ddc.name, dpc.name) AS company,
           COALESCE(dd.title, dp.title) AS deal_title,
           COALESCE(dd.production_phase, dp.production_phase) AS production_phase
      FROM manual_invoices mi
      LEFT JOIN proposals pr  ON pr.id  = mi.proposal_id
      LEFT JOIN deals dd      ON dd.id  = mi.deal_id
      LEFT JOIN deals dp      ON dp.id  = pr.deal_id
      LEFT JOIN companies c   ON c.id   = mi.company_id
      LEFT JOIN companies ddc ON ddc.id = dd.company_id
      LEFT JOIN companies dpc ON dpc.id = dp.company_id
     WHERE mi.status = 'issued'
       AND (mi.company_id IS NOT NULL OR mi.deal_id IS NOT NULL OR pr.deal_id IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM signatures s
           JOIN proposals p2 ON p2.id = s.proposal_id
          WHERE p2.deal_id = COALESCE(mi.deal_id, pr.deal_id)
            AND (s.data->>'total') ~ '^[0-9]+(\\.[0-9]+)?$'
       )
       -- Standalone "invoice now" / PO-converted extra invoices are already
       -- counted via the deal's extra line (extrasByDeal). Excluding any invoice
       -- linked to an extra here prevents double-counting it on unsigned deals
       -- (a final invoice with extras is already excluded by the signature guard).
       AND NOT EXISTS (
         SELECT 1 FROM deal_extras de WHERE de.xero_invoice_id = mi.xero_invoice_id
       )
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
      note: r.deal_title || null,
      amountExVat: round2(net),
      vat: round2(vat),
      status: 'invoiced',
      dealId: r.deal_id || null,
      // A deal in production is a "project" — drives the row's Deal/Project label.
      isProject: !!r.production_phase,
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
  const invoiced = round2(sumLinesByStatus(po, true) + sumLinesByStatus(normal, true) + companyInvoicedNet + manualInvoiced);
  const notInvoiced = round2(sumLinesByStatus(po, false) + sumLinesByStatus(normal, false) + (manualTotal - manualInvoiced));

  // Recurring "Other" revenue (web hosting etc.) — sits alongside Partners as
  // ongoing monthly income, kept out of the invoiced/not-invoiced split.
  const other = await fetchRecurringOther();
  const otherTotal = round2(other.reduce((s, x) => s + (Number(x.amountExVat) || 0), 0));

  return {
    normal, po, manual, companyInvoices, other,
    totals: { normal: sum(normal), po: sum(po), manual: manualTotal, manualInvoiced, companyInvoices: companyInvoicedNet, other: otherTotal, invoiced, notInvoiced },
  };
}

// Fire a broadcast IN-APP alert (no email) when a pending payment is ticked off
// as paid — an imported PP/PO row here, or a partner fee from api/partner. Sales
// & finance channel (the £ bell). Best-effort: never blocks the mark-paid reply.
export async function notifyPpMarkedPaid({ label, amount, method, actorName }) {
  try {
    const money = gbp(Number(amount) || 0);
    const by = actorName ? ` by ${actorName}` : '';
    const via = method ? ` (${method})` : '';
    await sendNotification('pp.marked_paid', {
      inAppOnly: true,
      subject: `Pending payment marked paid: ${label}`,
      text: `${label} marked paid${via}${by}.`,
      inApp: {
        title: `Payment received: ${label || 'Pending payment'}`,
        body: `${money}${via} marked paid${by}.`,
        link: '#/finance',
      },
    });
  } catch (err) {
    console.warn('[stats] pp.marked_paid notify failed', err.message);
  }
}

// GET list / POST import / DELETE one — the imported manual pending payments.
// Caller has already checked settings.manage. `action` carries the row id on
// DELETE. POST body: { rows: [{company,invoiceType,description,amountExVat,vat,paymentMethod,note}], mode }.
async function pendingManualRoute(req, res, action, user) {
  await ensureManualPendingPayments();

  if (req.method === 'GET') {
    const wantArchived = req.query?.archived === '1' || /[?&]archived=1(?:&|$)/.test(req.url || '');
    return res.status(200).json({ rows: await fetchManualPending({ archived: wantArchived }) });
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
    // Ad-hoc edit of the row's own fields (correct an imported figure/label) —
    // { fields: { company?, invoiceType?, description?, note?, poNumber?,
    // amountExVat?, vat? } }. Only the keys present are changed; the rest keep
    // their current value. Money fields are ex-VAT, coerced to numbers.
    if (body.fields && typeof body.fields === 'object') {
      const f = body.fields;
      const [cur] = await sql`SELECT * FROM manual_pending_payments WHERE id = ${action}`;
      if (!cur) return res.status(404).json({ error: 'Row not found' });
      const company     = 'company' in f ? trimOrNull(f.company) : cur.company;
      const invoiceType = 'invoiceType' in f ? trimOrNull(f.invoiceType) : cur.invoice_type;
      const description = 'description' in f ? trimOrNull(f.description) : cur.description;
      const note        = 'note' in f ? trimOrNull(f.note) : cur.note;
      const poNumber    = 'poNumber' in f ? trimOrNull(f.poNumber) : cur.po_number;
      const amount      = 'amountExVat' in f ? (numberOrNull(f.amountExVat) || 0) : Number(cur.amount_ex_vat) || 0;
      const vat         = 'vat' in f ? (numberOrNull(f.vat) || 0) : Number(cur.vat) || 0;
      await sql`
        UPDATE manual_pending_payments
           SET company = ${company}, invoice_type = ${invoiceType}, description = ${description},
               note = ${note}, po_number = ${poNumber}, amount_ex_vat = ${amount}, vat = ${vat}
         WHERE id = ${action}`;
      return res.status(200).json({ ok: true, rows: await fetchManualPending() });
    }
    // Link (or unlink) the row to a CRM deal. { dealId: '<id>' | null }.
    // A row links to a deal OR a company, never both — picking a deal clears
    // any company link.
    if ('dealId' in body) {
      const dealId = trimOrNull(body.dealId);
      await sql`UPDATE manual_pending_payments SET deal_id = ${dealId}, company_id = NULL WHERE id = ${action}`;
      return res.status(200).json({ ok: true, rows: await fetchManualPending() });
    }
    // Link (or unlink) the row to a customer (company). { companyId: '<id>' | null }.
    // Picking a company clears any deal link (mutually exclusive).
    if ('companyId' in body) {
      const companyId = trimOrNull(body.companyId);
      await sql`UPDATE manual_pending_payments SET company_id = ${companyId}, deal_id = NULL WHERE id = ${action}`;
      return res.status(200).json({ ok: true, rows: await fetchManualPending() });
    }
    // Archive (or restore) the row. Archived rows drop off the outstanding list
    // but remain retrievable in the archive view — distinct from Remove.
    if ('archived' in body) {
      const archived = body.archived !== false; // default → archived
      await sql`UPDATE manual_pending_payments SET archived = ${archived} WHERE id = ${action}`;
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
    const [before] = await sql`SELECT company, description, amount_ex_vat FROM manual_pending_payments WHERE id = ${action}`;
    await sql`
      UPDATE manual_pending_payments
         SET status = ${paid ? 'paid' : 'pending'},
             paid_at = ${paid ? new Date().toISOString() : null},
             paid_method = ${paid ? (method || null) : null}
       WHERE id = ${action}`;
    // Only alert on a transition INTO paid (not when un-marking).
    if (paid && before) {
      await notifyPpMarkedPaid({
        label: before.company || before.description || 'Pending payment',
        amount: before.amount_ex_vat,
        method,
        actorName: user?.name || user?.email || null,
      });
    }
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

// Predicted-this-month payments — a manually curated shortlist of pending
// payments the user expects to land this calendar month. We store only a set of
// opaque item keys (each computed client-side per pending row, e.g. `deal:<id>`,
// `manual:<id>`, `partner:<key>`) scoped to a `YYYY-MM` month, plus a label +
// amount snapshot for record-keeping. The Finance "Predicted" tab derives the
// live list by intersecting these keys with the current pending rows, so a paid
// item naturally drops off. A new month starts empty.
let predictedPaymentsReady = null;
function ensurePredictedPayments() {
  if (predictedPaymentsReady) return predictedPaymentsReady;
  predictedPaymentsReady = sql`
    CREATE TABLE IF NOT EXISTS predicted_payments (
      item_key text NOT NULL,
      month text NOT NULL,
      label text,
      amount_ex_vat numeric DEFAULT 0,
      created_by text,
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (item_key, month)
    )
  `
    // `excluded` flips an auto-included item (active partner / other recurring)
    // OFF for a given month, so it drops out of the predicted list + projection.
    .then(() => sql`ALTER TABLE predicted_payments ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false`)
    .then(() => true).catch((err) => { predictedPaymentsReady = null; throw err; });
  return predictedPaymentsReady;
}

function serverMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Progress notes for predicted payments — keyed by the item's stable key (NOT
// month) so a "how this project/deal is progressing" note carries across months
// and covers auto-included partners / other recurring items too. Edited at the
// regular catch-up meetings about the predicted list.
let predictedNotesReady = null;
function ensurePredictedPaymentNotes() {
  if (predictedNotesReady) return predictedNotesReady;
  predictedNotesReady = sql`
    CREATE TABLE IF NOT EXISTS predicted_payment_notes (
      item_key text PRIMARY KEY,
      note text,
      updated_by text,
      updated_at timestamptz DEFAULT now()
    )
  `.then(() => true).catch((err) => { predictedNotesReady = null; throw err; });
  return predictedNotesReady;
}

// GET  /stats/predicted-payments/:month   → { month, keys, items, bankedNet, notes }
// POST /stats/predicted-payments/:month     { itemKey, predicted, label, amountExVat }
//                                       OR  { itemKey, note }  (upsert/clear a note)
async function predictedPaymentsRoute(req, res, action, user) {
  await Promise.all([ensurePredictedPayments(), ensurePredictedPaymentNotes()]);
  const month = /^\d{4}-\d{2}$/.test(action || '') ? action : serverMonthKey();

  const snapshot = async () => {
    const rows = await sql`SELECT item_key, label, amount_ex_vat, excluded FROM predicted_payments WHERE month = ${month}`;
    const noteRows = await sql`SELECT item_key, note FROM predicted_payment_notes`;
    const notes = {};
    for (const r of noteRows) if (r.note) notes[r.item_key] = r.note;
    // The cash already banked this calendar month — the base the predicted
    // total is added to for the projected month-end figure.
    let bankedNet = 0;
    try { bankedNet = round2((await incomeReport(month)).total || 0); } catch { bankedNet = 0; }
    const included = rows.filter((r) => !r.excluded);
    const includedKeys = included.map((r) => r.item_key);

    // Roll unfulfilled predictions forward: any manual prediction flagged in an
    // EARLIER month that isn't already handled this month surfaces in the current
    // month too — they're likely to land now. The client intersects these keys
    // with the live pending list, so ones that were actually paid drop off; only
    // still-outstanding ones show. Only the current month accumulates the carry-
    // over (past months keep their own historical list). Auto items (partners /
    // other recurring) recur on their own, so they need no rollover.
    let rolledKeys = [];
    let rolledAwayKeys = [];
    const cur = serverMonthKey();
    if (month === cur) {
      const handledThisMonth = new Set(rows.map((r) => r.item_key)); // included OR excluded here
      const prior = await sql`
        SELECT DISTINCT item_key FROM predicted_payments
         WHERE month < ${month} AND excluded = false`;
      rolledKeys = prior.map((r) => r.item_key).filter((k) => !handledThisMonth.has(k));
    } else if (month < cur) {
      // This is an earlier month: any of its predictions that carry over into the
      // current month have MOVED there, so they no longer belong to this month's
      // list (the client hides them). "Handled in the current month" (re-flagged
      // or excluded there) means it didn't roll, so it stays on this month.
      const handledInCurrent = new Set(
        (await sql`SELECT item_key FROM predicted_payments WHERE month = ${cur}`).map((r) => r.item_key),
      );
      rolledAwayKeys = includedKeys.filter((k) => !handledInCurrent.has(k));
    }

    return {
      month,
      bankedNet,
      keys: [...includedKeys, ...rolledKeys],
      items: included.map((r) => ({ key: r.item_key, label: r.label || null, amount: Number(r.amount_ex_vat) || 0 })),
      // Auto-included items the user has switched OFF for this month.
      excludedKeys: rows.filter((r) => r.excluded).map((r) => r.item_key),
      // Predictions carried over INTO this month from an earlier one (current month
      // only). Removing one excludes it.
      rolledKeys,
      // Predictions that have rolled OUT of this (past) month into the current one,
      // so they should be hidden here.
      rolledAwayKeys,
      notes,
    };
  };

  if (req.method === 'GET') {
    return res.status(200).json(await snapshot());
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const body = req.body || {};
    const itemKey = trimOrNull(body.itemKey);
    if (!itemKey) return res.status(400).json({ error: 'itemKey required' });
    // Note upsert/clear — distinct from the predicted toggle (no `predicted`).
    if ('note' in body) {
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      const actor = user?.name || user?.email || null;
      if (note) {
        await sql`
          INSERT INTO predicted_payment_notes (item_key, note, updated_by, updated_at)
          VALUES (${itemKey}, ${note}, ${actor}, NOW())
          ON CONFLICT (item_key)
          DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
      } else {
        await sql`DELETE FROM predicted_payment_notes WHERE item_key = ${itemKey}`;
      }
      return res.status(200).json(await snapshot());
    }
    // Exclude / re-include an auto item (active partner / other recurring) for
    // this month — distinct from the manual predicted toggle.
    if ('excluded' in body) {
      const label = trimOrNull(body.label);
      const amount = numberOrNull(body.amountExVat) || 0;
      const actor = user?.name || user?.email || null;
      if (body.excluded) {
        await sql`
          INSERT INTO predicted_payments (item_key, month, label, amount_ex_vat, created_by, excluded)
          VALUES (${itemKey}, ${month}, ${label}, ${amount}, ${actor}, true)
          ON CONFLICT (item_key, month)
          DO UPDATE SET excluded = true, label = EXCLUDED.label, amount_ex_vat = EXCLUDED.amount_ex_vat`;
      } else {
        await sql`DELETE FROM predicted_payments WHERE item_key = ${itemKey} AND month = ${month} AND excluded = true`;
      }
      return res.status(200).json(await snapshot());
    }
    const predicted = body.predicted !== false; // default → mark predicted
    if (predicted) {
      const label = trimOrNull(body.label);
      const amount = numberOrNull(body.amountExVat) || 0;
      const actor = user?.name || user?.email || null;
      await sql`
        INSERT INTO predicted_payments (item_key, month, label, amount_ex_vat, created_by)
        VALUES (${itemKey}, ${month}, ${label}, ${amount}, ${actor})
        ON CONFLICT (item_key, month)
        DO UPDATE SET label = EXCLUDED.label, amount_ex_vat = EXCLUDED.amount_ex_vat`;
    } else {
      await sql`DELETE FROM predicted_payments WHERE item_key = ${itemKey} AND month = ${month} AND excluded = false`;
      // If this item is still flagged in an earlier month it would roll back into
      // the current month, so a plain delete wouldn't stick. Drop an excluded
      // marker for the current month to suppress the carry-over.
      if (month === serverMonthKey()) {
        const [prior] = await sql`SELECT 1 FROM predicted_payments WHERE item_key = ${itemKey} AND month < ${month} AND excluded = false LIMIT 1`;
        if (prior) {
          await sql`
            INSERT INTO predicted_payments (item_key, month, excluded)
            VALUES (${itemKey}, ${month}, true)
            ON CONFLICT (item_key, month) DO UPDATE SET excluded = true`;
        }
      }
    }
    return res.status(200).json(await snapshot());
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
    sql`SELECT pay.amount AS inc, pay.paid_at, pr.data->>'vatRate' AS rate, pr.id AS proposal_id,
               d.id AS deal_id, c.name AS company, pr.number_year AS ny, pr.number_seq AS ns
          FROM payments pay
          JOIN proposals pr ON pr.id = pay.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE pay.paid_at >= ${since} AND pay.paid_at < ${until}`,
    sql`SELECT pi.amount AS inc, pi.paid_at, pr.data->>'vatRate' AS rate, pr.id AS proposal_id,
               d.id AS deal_id, c.name AS company, pr.number_year AS ny, pr.number_seq AS ns
          FROM partner_invoices pi
          JOIN proposals pr ON pr.id = pi.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE pi.paid_at >= ${since} AND pi.paid_at < ${until}`,
    sql`SELECT mp.amount AS inc, mp.paid_at, pr.data->>'vatRate' AS rate, mp.id AS edit_key, mp.payment_method AS method, pr.id AS proposal_id,
               d.id AS deal_id, c.name AS company, pr.number_year AS ny, pr.number_seq AS ns
          FROM manual_payments mp
          JOIN proposals pr ON pr.id = mp.proposal_id
          LEFT JOIN deals d ON d.id = pr.deal_id
          LEFT JOIN companies c ON c.id = d.company_id
         WHERE mp.manual_invoice_id IS NULL
           AND mp.paid_at >= ${since} AND mp.paid_at < ${until}`,
    sql`SELECT mi.amount AS inc, mi.paid_at, mi.subtotal_ex_vat, mi.tax_amount,
               pr.data->>'vatRate' AS rate, mi.id AS edit_key, mi.payment_method AS method, pr.id AS proposal_id,
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
    sql`SELECT pb.paid_amount AS inc, pb.paid_at, pr.data->>'vatRate' AS rate, pb.xero_invoice_id AS edit_key, pb.payment_method AS method, pr.id AS proposal_id,
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
      // Internal, for dedupe only — stripped from the response below.
      proposalId: r.proposal_id || null,
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

  // Recurring "Other" revenue marked received this period — labelled by customer.
  const recPaid = await fetchPaidRecurringOther(since, until);
  for (const r of recPaid) {
    const net = Number(r.net) || 0;
    const vat = Number(r.vat) || 0;
    push({ paid_at: r.paid_at, company: r.company, edit_key: r.edit_key }, 'recurring', { net, vat, gross: net + vat });
  }

  // Partner subscription fees marked paid this period — labelled by partner name.
  const feePaid = await fetchPaidPartnerFees(since, until);
  for (const r of feePaid) {
    const net = Number(r.net) || 0;
    const vat = Number(r.vat) || 0;
    push({ paid_at: r.paid_at, company: r.company, edit_key: r.edit_key, method: r.method }, 'partnerfee', { net, vat, gross: net + vat });
  }

  // Drop duplicates (same proposal paid the same gross on the same day via two
  // mechanisms), then strip the internal proposalId from the response.
  const deduped = dedupePaymentRows(rows).map(({ proposalId, ...rest }) => rest); // eslint-disable-line no-unused-vars
  deduped.sort((a, b) => (a.paidAt < b.paidAt ? 1 : a.paidAt > b.paidAt ? -1 : 0));
  const total = round2(deduped.reduce((s, r) => s + r.net, 0));

  return { period, rows: deduped, total };
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
  } else if (source === 'recurring') {
    await sql`UPDATE recurring_other_payments SET paid_at = ${iso} WHERE id = ${key}`;
  } else if (source === 'partnerfee') {
    await sql`UPDATE partner_fee_payments SET paid_at = ${iso} WHERE id = ${key}`;
  } else {
    return res.status(400).json({ error: 'This payment type cannot be re-dated here' });
  }
  return res.status(200).json({ ok: true, paidAt: iso });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cash Flow — company costs, monthly profit, Corporation Tax to set aside and the
// wage-based revenue targets. Admin-only (rides on the same settings.manage gate
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
  ['Ben Car Lease', 'director', 339.00, true, null],
  // Marketing.
  ['PPC Budget UK', 'marketing', 3000.00, true, null],
  ['Sophie Risan - Marketing Fee', 'marketing', 600.00, true, null],
  // Directors — pension, salaries (Adam/Ben/Anna); Ben's car lease is above.
  ['Director Pensions Base (£300 each PM)', 'director', 600.00, true, null],
  ['Anna - part of B salary', 'director', 1047.50, true, null],
  ['Ben', 'director', 2113.50, true, null],
  ['Adam', 'director', 3500.00, true, null],
  // Director personal tax saving — auto-calculated (see flags migration below).
  ['Director personal tax saving', 'director', 950.00, true, null],
  ['Callum', 'wages', 2480.00, true, null],
  ['Callum commission', 'wages', 448.55, true, null],
  ['Chloe', 'wages', 800.00, true, null],
  ['Hannah Bales', 'wages', 2121.11, true, null],
  ['Adam Leveson', 'wages', 2121.11, true, null],
  // Freelancers.
  ['Lesley Ovington', 'freelancer', 1750.00, true, null],
  ['Freelance Copywriter', 'freelancer', 170.00, true, null],
  // Director allowances — June 2026 one-offs.
  ['Adam Director allowance', 'allowance', 250.00, false, '2026-06'],
  ['Ben Director allowance', 'allowance', 250.00, false, '2026-06'],
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
    // auto_type: a derived row whose amount is computed, not entered (currently
    // 'director_tax'). tax_basis: a salary row that feeds the director-tax calc.
    await sql`ALTER TABLE cashflow_costs ADD COLUMN IF NOT EXISTS auto_type TEXT`;
    await sql`ALTER TABLE cashflow_costs ADD COLUMN IF NOT EXISTS tax_basis BOOLEAN NOT NULL DEFAULT false`;
    // One-time cleanup: the profit-goal / suggested-target feature was removed,
    // so drop its now-dead column. IF EXISTS makes this an idempotent no-op once
    // it's run (safe to leave; can be deleted in a later pass).
    await sql`ALTER TABLE settings DROP COLUMN IF EXISTS cashflow_profit_goal`;

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
    // (Historical) the original seeded allowances were moved expense → director.
    const [{ dcount }] = await sql`SELECT COUNT(*)::int AS dcount FROM cashflow_costs WHERE category = 'director'`;
    if (dcount === 0) {
      await sql`UPDATE cashflow_costs SET category = 'director' WHERE id IN ('cfseed44', 'cfseed45') AND category = 'expense'`;
    }
    // Directors split: 'director' now holds the directors themselves (Adam/Ben/Anna
    // + Ben's car + pension); the two allowances move to their own 'allowance'
    // category. Runs once (until an 'allowance' row exists).
    const [{ acount }] = await sql`SELECT COUNT(*)::int AS acount FROM cashflow_costs WHERE category = 'allowance'`;
    if (acount === 0) {
      await sql`UPDATE cashflow_costs SET category = 'allowance' WHERE id IN ('cfseed44', 'cfseed45') AND category = 'director'`;
      await sql`UPDATE cashflow_costs SET category = 'director' WHERE id IN ('cfseed33', 'cfseed34', 'cfseed35') AND category = 'wages'`;
      await sql`UPDATE cashflow_costs SET category = 'director' WHERE id IN ('cfseed29', 'cfseed32') AND category = 'expense'`;
    }
    // Director personal tax saving auto-calculates from Adam + Ben's salaries.
    // Mark the derived row and the two salary rows it's based on. Runs once.
    const [{ autocount }] = await sql`SELECT COUNT(*)::int AS autocount FROM cashflow_costs WHERE auto_type IS NOT NULL`;
    if (autocount === 0) {
      await sql`UPDATE cashflow_costs SET auto_type = 'director_tax', category = 'director' WHERE id = 'cfseed36'`;
      await sql`UPDATE cashflow_costs SET tax_basis = true WHERE id IN ('cfseed34', 'cfseed35')`;
    }
    // If a prior version split Adam/Ben into base-salary + dividend rows, fold
    // them back into a single combined row each (tax_basis flagged) and drop the
    // dividend rows. Runs once (guard: dividend rows still exist).
    const [{ tosplit }] = await sql`SELECT COUNT(*)::int AS tosplit FROM cashflow_costs WHERE id IN ('cfdivadam', 'cfdivben')`;
    if (tosplit > 0) {
      for (const [baseId, divId, name] of [['cfseed35', 'cfdivadam', 'Adam'], ['cfseed34', 'cfdivben', 'Ben']]) {
        const [b] = await sql`SELECT amount FROM cashflow_costs WHERE id = ${baseId}`;
        const [d] = await sql`SELECT amount FROM cashflow_costs WHERE id = ${divId}`;
        if (!b) continue;
        const total = round2((Number(b.amount) || 0) + (Number(d?.amount) || 0));
        await sql`UPDATE cashflow_costs SET label = ${name}, amount = ${total}, tax_basis = true WHERE id = ${baseId}`;
        await sql`DELETE FROM cashflow_costs WHERE id = ${divId}`;
      }
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

// Cost categories: staff wages, freelancers, marketing, director allowances,
// compulsory savings and operating expenses. Anything unrecognised falls back to
// 'expense'. 'savings' is a committed set-aside — it counts toward the monthly
// target but is NOT tax-deductible (see deductibleCostTotalForMonth).
const CATEGORIES = ['wages', 'freelancer', 'marketing', 'director', 'allowance', 'savings'];
const normCategory = (c) => (CATEGORIES.includes(c) ? c : 'expense');

// UK personal income tax on an annual figure (2025/26 bands): £12,570 personal
// allowance (tapered £1 per £2 over £100k), 20% to £37,700 taxable, 40% to the
// £125,140 threshold, 45% above.
function ukIncomeTax(annual) {
  const a = Math.max(0, Number(annual) || 0);
  const pa = a > 125140 ? 0 : a > 100000 ? Math.max(0, 12570 - (a - 100000) / 2) : 12570;
  let taxable = Math.max(0, a - pa);
  let tax = 0;
  const basic = Math.min(taxable, 37700); tax += basic * 0.20; taxable -= basic;
  const higher = Math.min(taxable, 125140 - 37700); tax += higher * 0.40; taxable -= higher;
  tax += Math.max(taxable, 0) * 0.45;
  return tax;
}

// Employee (Class 1) NI on an annual salary (2025/26): 8% between the £12,570
// primary threshold and the £50,270 upper earnings limit, 2% above.
function employeeNI(annual) {
  const a = Math.max(0, Number(annual) || 0);
  return Math.min(Math.max(a - 12570, 0), 50270 - 12570) * 0.08 + Math.max(a - 50270, 0) * 0.02;
}

// Total personal tax a director should set aside on `annual` drawings, treating
// the figure as gross salary: income tax + employee NI (the full set-aside).
// Estimate only — ignores other income and the >£100k PA taper interaction.
function directorPersonalTax(annual) {
  return ukIncomeTax(annual) + employeeNI(annual);
}

// Dividend tax (2025/26) on an annual dividend that sits ON TOP of `otherIncome`
// (the director's salary). The £500 dividend allowance is 0%-rated but still uses
// up band space; rates are 8.75% (basic), 33.75% (higher), 39.35% (additional),
// with band tops at £50,270 and £125,140 of total income. No NI on dividends.
// Estimate only — assumes the personal allowance is already used by salary.
const DIV_ALLOWANCE = 500;
const DIV_BASIC = 0.0875, DIV_HIGHER = 0.3375, DIV_ADDL = 0.3935;
const BAND_BASIC_TOP = 50270, BAND_HIGHER_TOP = 125140;
function dividendTaxOn(dividend, otherIncome) {
  let d = Math.max(0, Number(dividend) || 0);
  if (d <= 0) return 0;
  let pos = Math.max(0, Number(otherIncome) || 0);
  let tax = 0;
  const allow = Math.min(d, DIV_ALLOWANCE); pos += allow; d -= allow; // 0% but occupies band
  const basic = Math.max(0, Math.min(d, BAND_BASIC_TOP - pos)); tax += basic * DIV_BASIC; pos += basic; d -= basic;
  const higher = Math.max(0, Math.min(d, BAND_HIGHER_TOP - pos)); tax += higher * DIV_HIGHER; pos += higher; d -= higher;
  tax += Math.max(0, d) * DIV_ADDL;
  return tax;
}

// Shared with the Finance "VAT & Corp tax" report: load the cost base once.
async function loadCashflowCostRows() {
  await ensureCashflow();
  return sql`SELECT * FROM cashflow_costs ORDER BY sort_order ASC NULLS LAST, created_at ASC`;
}

// CORPORATION TAX deductible cost base for a month. Dividends and personal tax
// are NOT deductible against profit: each tax_basis director (Adam/Ben) takes a
// £12,570/yr salary (deductible) plus dividends (not deductible, paid from
// post-tax profit), and the auto personal-tax line isn't a company expense at
// all. So cap each tax_basis row at the salary and drop the personal-tax line;
// everything else (staff, freelancers, marketing, pensions, Anna's salary, the
// car lease, overheads, allowances) deducts in full. Estimate — confirm with the
// accountant; note VAT-inclusive cost entries would slightly overstate this.
const DIRECTOR_DEDUCTIBLE_SALARY_MONTHLY = 12570 / 12; // £1,047.50/mo per director
function deductibleCostTotalForMonth(costRows, mk) {
  let total = 0;
  for (const r of costRows) {
    if (!costAppliesToMonth(r, mk)) continue;
    if (r.auto_type === 'director_tax') continue; // personal income tax + NI — not a company expense
    if (r.category === 'savings') continue; // compulsory savings — a set-aside, not a deductible cost
    const amt = monthlyAmountOf(r);
    total += (r.tax_basis === true) ? Math.min(amt, DIRECTOR_DEDUCTIBLE_SALARY_MONTHLY) : amt;
  }
  return round2(total);
}

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
    autoType: r.auto_type || null,
    taxBasis: r.tax_basis === true,
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

// Corporation Tax to set aside for ONE month, from its taxable profit. We
// annualise the month (×12) to pick the right HMRC marginal band, then take a
// twelfth back. Self-contained per month — so a profitable month reserves CT
// even while earlier months are empty/unfilled (a trailing-12m or year-to-date
// rate reads 0% until the back-months catch up, which is why CT showed £0). A
// loss month reserves nothing.
function monthlyCorpTax(taxProfit) {
  const tp = Math.max(0, Number(taxProfit) || 0);
  return round2(corpTaxOn(tp * 12) / 12);
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

  // Costs (resolved per month from the recurring + one-off rows).
  const costRows = await sql`SELECT * FROM cashflow_costs ORDER BY sort_order ASC NULLS LAST, created_at ASC`;

  // Director expenses (from the Directors tab) feed the cost base too — the
  // combined monthly spend lands in the 'director' bucket and is CT-deductible.
  // Recurring-aware via expenseActiveInMonth (hoisted; defined below).
  await ensureDirectorExpenses();
  const dirExpRows = await sql`SELECT amount, month, recurring, effective_to FROM director_expenses`;
  const dirSpend = (mk) => round2(dirExpRows.reduce((s, r) => s + (expenseActiveInMonth(r, mk) ? (Number(r.amount) || 0) : 0), 0));
  // Director allowance as a committed monthly cost: the base entitlement
  // (£250/mo per director) rising to actual spend when the directors go over it.
  // This lands in the 'allowance' bucket (Director Allowances panel) INSTEAD of the
  // raw director-tab spend going into the 'director' bucket — so the allowance is
  // always shown and factored (never £0), and there's no double-count.
  const DIR_ALLOWANCE_BASE = DIRECTOR_ALLOWANCE * DIRECTOR_EMAILS.size;
  const dirAllowanceForMonth = (mk) => round2(Math.max(DIR_ALLOWANCE_BASE, dirSpend(mk)));

  // Auto director personal-tax saving: income tax + employee NI on each tax_basis
  // director's drawings (annualised), summed back to a monthly figure. Recomputes
  // whenever the underlying figures change. The amount stored on the row is ignored.
  const autoDirectorTaxMonthly = round2(
    costRows.filter((r) => r.tax_basis === true)
      .reduce((s, r) => s + directorPersonalTax(monthlyAmountOf(r) * 12) / 12, 0),
  );
  const resolvedAmount = (r) => (r.auto_type === 'director_tax' ? autoDirectorTaxMonthly : monthlyAmountOf(r));

  // Auto Staff Commission per month — calculated from paid sales for on-plan
  // staff (cash basis, ex-VAT), resetting to £0 each month. A real, CT-deductible
  // operating cost. Recomputes whenever the underlying paid sales change; there's
  // no stored cost row. { 'YYYY-MM': total }.
  const commByMonth = await commissionTotalsForMonths(keys);

  // Operating costs per month — everything EXCEPT the auto Corporation Tax line.
  const opCostsForMonth = (mk) => {
    let wages = 0, expenses = 0, freelancers = 0, marketing = 0, director = 0, allowance = 0, savings = 0;
    for (const r of costRows) {
      if (!costAppliesToMonth(r, mk)) continue;
      const amt = resolvedAmount(r);
      const cat = normCategory(r.category);
      if (cat === 'wages') wages += amt;
      else if (cat === 'freelancer') freelancers += amt;
      else if (cat === 'marketing') marketing += amt;
      else if (cat === 'director') director += amt;
      else if (cat === 'allowance') allowance += amt;
      else if (cat === 'savings') savings += amt;
      else expenses += amt;
    }
    allowance += dirAllowanceForMonth(mk); // director allowance (£250/mo per director, rising to actual spend if over)
    const commission = round2(commByMonth[mk] || 0); // auto staff commission (paid sales)
    // Savings is in the total (so it's part of the break-even target and comes out
    // of the drawable surplus), but it was excluded from the CT-deductible base
    // above — so Corporation Tax is still computed on the full pre-savings profit.
    return { wages: round2(wages), expenses: round2(expenses), freelancers: round2(freelancers), marketing: round2(marketing), director: round2(director), allowance: round2(allowance), savings: round2(savings), commission, total: round2(wages + expenses + freelancers + marketing + director + allowance + savings + commission) };
  };

  const opHistory = keys.map((mk) => {
    const c = opCostsForMonth(mk);
    const cashIn = round2(cashByMonth[mk] || 0);
    // Director expenses are NOT treated as CT-deductible here on purpose — we'd
    // rather over-reserve Corporation Tax and let the accountant decide later, so
    // they're excluded from the taxable-profit base (but still in operating costs).
    // Commission is a genuine deductible cost (unlike savings), so it lowers the
    // taxable-profit base as well as operating profit.
    return { month: mk, c, cashIn, opProfit: round2(cashIn - c.total), taxProfit: round2(cashIn - deductibleCostTotalForMonth(costRows, mk) - c.commission) };
  });

  // Corporation Tax per month on TAXABLE profit (cash − the CT-deductible cost
  // base: director dividends and the personal-tax line are excluded — see
  // deductibleCostTotalForMonth). Each month is annualised to pick the HMRC
  // marginal band (monthlyCorpTax), so a profitable month reserves CT regardless
  // of empty earlier months. Pre-CT so it never feeds its own basis, then folded
  // into the expenses bucket + total so profit, costs and the revenue targets are
  // all CT-inclusive (a loss month reserves nothing).
  const cashIn12 = round2(opHistory.reduce((s, h) => s + h.cashIn, 0));
  const history = opHistory.map((h) => {
    const corpTax = monthlyCorpTax(h.taxProfit);
    const expenses = round2(h.c.expenses + corpTax);
    const costs = round2(h.c.total + corpTax);
    return { month: h.month, cashIn: h.cashIn, wages: h.c.wages, expenses, freelancers: h.c.freelancers, marketing: h.c.marketing, director: h.c.director, allowance: h.c.allowance, savings: h.c.savings, commission: h.c.commission, corpTax, costs, profit: round2(h.cashIn - costs) };
  });
  const costs12 = round2(history.reduce((s, h) => s + h.costs, 0));

  const sel = history[history.length - 1];
  const selOp = opHistory[opHistory.length - 1];
  const corpTaxMonthly = sel.corpTax;
  const inProfit = selOp.taxProfit > 0.005;
  const effectiveRate = inProfit ? corpTaxMonthly / selOp.taxProfit : 0;
  const ctYear = round2(corpTaxOn(Math.max(0, selOp.taxProfit) * 12)); // annualised current-month run-rate
  const monthReserve = corpTaxMonthly;

  // Targets. The "minimum" is the full cost base (break-even). Rather than fixed
  // £4k/£5k wage targets (which baked in a personal-tax assumption that didn't
  // match how the directors actually draw), we surface the SURPLUS above the
  // minimum — the distributable, post-Corporation-Tax profit (sel.profit) — split
  // evenly between the tax_basis directors, with the personal tax on each share
  // treated as DIVIDENDS (post-CT profit → dividend tax, no NI, no CT effect).
  // The share is annualised on top of the director's salary for band placement
  // (consistent with the rest of the tab's annualised estimates). tax_basis rows
  // carry the director names in r.label.
  const WAGE_BASELINE = 3000;
  const taxBasisRows = costRows.filter((r) => r.tax_basis === true && costAppliesToMonth(r, month));
  const numDirectors = taxBasisRows.length || 2;
  const surplus = Math.max(0, sel.profit);
  const perDir = numDirectors ? surplus / numDirectors : 0;
  const drawdown = taxBasisRows.map((r) => {
    // `base` = the director's current monthly pay (their tax_basis cost row — edit
    // it in the Costs → Directors panel and it flows through here + the Minimum).
    // The even share of the surplus on top is taken as a dividend (post-CT profit).
    const base = round2(monthlyAmountOf(r));
    const salaryAnnual = monthlyAmountOf(r) * 12; // existing pay → dividend band placement
    const surplusTax = round2(dividendTaxOn(perDir * 12, salaryAnnual) / 12);
    const gross = round2(base + perDir); // whole wage available this month
    return { name: r.label || 'Director', base, surplus: round2(perDir), gross, tax: surplusTax, net: round2(gross - surplusTax) };
  });
  const wageTargets = {
    minimum: round2(sel.costs),
    baseline: WAGE_BASELINE,
    directors: numDirectors,
    surplus: {
      total: round2(surplus),                                        // surplus above the minimum
      perDirector: round2(perDir),
      grossTotal: round2(drawdown.reduce((s, d) => s + d.gross, 0)),  // whole wage available across directors
      directors: drawdown,
      taxTotal: round2(drawdown.reduce((s, d) => s + d.tax, 0)),      // dividend tax on the surplus portion
      netTotal: round2(drawdown.reduce((s, d) => s + d.net, 0)),
    },
  };

  const lines = costRows.filter((r) => costAppliesToMonth(r, month)).map(serialiseCost);
  // Reflect the computed value on the auto row (display + matches the totals).
  for (const l of lines) {
    if (l.autoType === 'director_tax') { l.amount = autoDirectorTaxMonthly; l.monthlyAmount = autoDirectorTaxMonthly; l.frequency = 'monthly'; }
  }
  // Auto Corporation Tax line — pinned to the top of the Expenses list and counted
  // in the totals (so the targets cover the CT bill). Display-only; no DB row, so
  // the frontend treats it as read-only (no edit / remove / drag).
  lines.unshift({
    id: 'cfcorptax', label: 'Corporation Tax (set aside)', category: 'expense',
    amount: corpTaxMonthly, frequency: 'monthly', monthlyAmount: corpTaxMonthly,
    note: null, autoType: 'corp_tax', taxBasis: false,
    recurring: true, month: null, effectiveFrom: null, effectiveTo: null,
  });
  // Director allowance for the month — the base entitlement (£250/mo per director)
  // rising to actual spend when the directors go over it. Shown read-only under
  // Director Allowances so it's always visible and reconciles with the totals.
  const dirSel = dirSpend(month);
  const dirAllow = dirAllowanceForMonth(month);
  lines.push({
    id: 'cfdirectorallowance', label: 'Director allowances (Adam + Ben)', category: 'allowance',
    amount: dirAllow, frequency: 'monthly', monthlyAmount: dirAllow,
    note: dirSel > DIR_ALLOWANCE_BASE + 0.005
      ? `Over the £${DIR_ALLOWANCE_BASE}/mo allowance — showing actual spend of £${dirSel.toFixed(2)}`
      : `£${DIRECTOR_ALLOWANCE}/mo per director; rises to actual spend if over`,
    autoType: 'director_allowance', taxBasis: false,
    recurring: true, month: null, effectiveFrom: null, effectiveTo: null,
  });
  // Auto Staff Commission for the month — calculated from on-plan staff's paid
  // sales, resetting to £0 each month. Read-only (autoType) and managed in the
  // Admin → Staff Commission tab; shown here so costs/profit/CT reconcile.
  // One read-only line per commissioned staff member ("<first name>'s commission")
  // in their own Staff Commission panel. The totals already include commission via
  // the separate bucket in opCostsForMonth, so these display rows never
  // double-count. Falls back to a single aggregate line if the per-member lookup
  // fails for any reason.
  try {
    const commMembers = await commissionByMemberForMonth(month);
    for (const cm of commMembers) {
      const first = String(cm.name || '').trim().split(/\s+/)[0] || cm.name || 'Staff';
      lines.push({
        id: 'cfcommission_' + cm.email, label: `${first}’s commission`, category: 'commission',
        amount: round2(cm.total), frequency: 'monthly', monthlyAmount: round2(cm.total),
        note: 'Auto — full commission at deposit paid / PO signed, plus paid extras; resets monthly (Admin → Staff Commission)',
        autoType: 'commission', taxBasis: false,
        recurring: true, month: null, effectiveFrom: null, effectiveTo: null,
      });
    }
  } catch (err) {
    console.warn('[cashflow] per-member commission lines failed', err.message);
    const commMonth = round2(commByMonth[month] || 0);
    lines.push({
      id: 'cfcommission', label: 'Staff Commission', category: 'commission',
      amount: commMonth, frequency: 'monthly', monthlyAmount: commMonth,
      note: 'Auto — full commission at deposit paid / PO signed, plus paid extras; resets monthly (Admin → Staff Commission)',
      autoType: 'commission', taxBasis: false,
      recurring: true, month: null, effectiveFrom: null, effectiveTo: null,
    });
  }
  const activityRows = await sql`SELECT id, actor_email, action, summary, created_at FROM cashflow_activity ORDER BY created_at DESC LIMIT 40`;

  return {
    month,
    selected: sel,
    corpTax: { effectiveRate, monthReserve, monthly: corpTaxMonthly, yearEstimate: ctYear, profit12: round2(selOp.taxProfit * 12), cashIn12, costs12, inProfit },
    targets: wageTargets,
    history,
    lines,
    activity: activityRows.map((r) => ({ id: String(r.id), actor: r.actor_email || null, action: r.action, summary: r.summary, createdAt: r.created_at })),
  };
}

// Writes for the Cash Flow tab. action carries the cost id for PATCH/DELETE.
//   POST { label, category, amount, recurring, month?, effectiveFrom? } → add a cost
//   PATCH/<id> { label?, category?, amount?, effectiveTo? }            → edit a cost
//   DELETE/<id>                                  → remove a cost
async function cashflowRoute(req, res, action, user) {
  await ensureCashflow();
  const actor = (user?.email || '').toLowerCase();

  if (req.method === 'POST' || req.method === 'PUT') {
    const body = req.body || {};
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
    // Accept a client-supplied id so the CRM undo/redo can re-add the same row
    // (redo of an add); fall back to a server id otherwise.
    const id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : makeId('cf');
    const [{ m }] = await sql`SELECT COALESCE(MAX(sort_order), -1) AS m FROM cashflow_costs`;
    await sql`
      INSERT INTO cashflow_costs (id, label, category, amount, frequency, note, recurring, month, effective_from, sort_order)
      VALUES (${id}, ${label}, ${category}, ${amount}, ${frequency}, ${note}, ${recurring}, ${month}, ${effectiveFrom}, ${m + 1})
      ON CONFLICT (id) DO NOTHING`;
    const kindWord = category === 'wages' ? 'wage' : category === 'freelancer' ? 'freelancer' : category === 'marketing' ? 'marketing cost' : category === 'director' ? 'director cost' : category === 'allowance' ? 'director allowance' : 'expense';
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
    const taxBasis = body.taxBasis !== undefined ? (body.taxBasis === true) : existing.tax_basis;
    const effectiveTo = body.effectiveTo !== undefined ? trimOrNull(body.effectiveTo) : existing.effective_to;
    await sql`
      UPDATE cashflow_costs
         SET label = ${label}, category = ${category}, amount = ${amount}, frequency = ${frequency}, note = ${note}, tax_basis = ${taxBasis}, effective_to = ${effectiveTo}, updated_at = NOW()
       WHERE id = ${action}`;
    const upWord = frequency === 'annual' ? `${gbp(Number(amount) || 0)}/yr` : gbp(Number(amount) || 0);
    await logCashflow(actor, 'cost.update', `Updated “${label}” to ${upWord}`);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const [existing] = await sql`SELECT * FROM cashflow_costs WHERE id = ${action}`;
    if (existing) {
      // Archive the full row first so the CRM undo/redo can restore it (same id).
      await archiveRecord('cashflow_cost', action, [{ table: 'cashflow_costs', row: existing }], actor);
      await sql`DELETE FROM cashflow_costs WHERE id = ${action}`;
      await logCashflow(actor, 'cost.delete', `Removed “${existing.label}” ${gbp(Number(existing.amount) || 0)}`);
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Writes for the "Other" recurring-revenue group in Pending Payments. `action`
// carries the row id for PATCH/DELETE. Returns the refreshed list each time.
//   POST  { label, note?, amountExVat, vat? }  → add a row
//   PATCH/<id> { label?, note?, amountExVat?, vat? }  → edit a row
//   DELETE/<id>                                → remove a row (archived for undo)
async function recurringOtherRoute(req, res, action, user) {
  await ensureRecurringOther();
  const actor = (user?.email || '').toLowerCase();

  if (req.method === 'POST' || req.method === 'PUT') {
    const body = req.body || {};

    // Mark a recurring line as received for a month → logs it as banked income
    // for that month (idempotent per line+month; re-marking refreshes the amount).
    if (body.receive) {
      const rid = trimOrNull(body.receive.id);
      const month = trimOrNull(body.receive.month);
      if (!rid || !/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'id and month (YYYY-MM) required' });
      const [line] = await sql`SELECT * FROM recurring_other_revenue WHERE id = ${rid}`;
      if (!line) return res.status(404).json({ error: 'Not found' });
      await ensureRecurringOtherPayments();
      const netOverride = numberOrNull(body.receive.net);
      const vatOverride = numberOrNull(body.receive.vat);
      const net = netOverride != null ? netOverride : Number(line.amount_ex_vat) || 0;
      const vat = vatOverride != null ? vatOverride : Number(line.vat) || 0;
      // Default the paid date to mid-day on the 1st of the month (UTC) so it lands
      // squarely inside the month regardless of timezone; caller may override.
      const paidAt = body.receive.paidAt ? new Date(body.receive.paidAt) : new Date(`${month}-01T12:00:00.000Z`);
      if (isNaN(paidAt.getTime())) return res.status(400).json({ error: 'Invalid date' });
      await sql`
        INSERT INTO recurring_other_payments (id, recurring_id, month, net, vat, paid_at)
        VALUES (${makeId('rop')}, ${rid}, ${month}, ${net}, ${vat}, ${paidAt.toISOString()})
        ON CONFLICT (recurring_id, month) DO UPDATE SET net = EXCLUDED.net, vat = EXCLUDED.vat, paid_at = EXCLUDED.paid_at`;
      return res.status(200).json({ ok: true, rows: await fetchRecurringOther() });
    }
    // Un-mark a month → removes it from banked income again.
    if (body.unreceive) {
      const rid = trimOrNull(body.unreceive.id);
      const month = trimOrNull(body.unreceive.month);
      if (!rid || !month) return res.status(400).json({ error: 'id and month required' });
      await ensureRecurringOtherPayments();
      await sql`DELETE FROM recurring_other_payments WHERE recurring_id = ${rid} AND month = ${month}`;
      return res.status(200).json({ ok: true, rows: await fetchRecurringOther() });
    }

    // Drag-reorder: persist the given ids in their new order.
    if (Array.isArray(body.reorder)) {
      let i = 0;
      for (const rid of body.reorder) {
        if (typeof rid !== 'string') continue;
        await sql`UPDATE recurring_other_revenue SET sort_order = ${i} WHERE id = ${rid}`;
        i += 1;
      }
      return res.status(200).json({ ok: true, rows: await fetchRecurringOther() });
    }
    const label = trimOrNull(body.label);
    if (!label) return res.status(400).json({ error: 'label required' });
    const amount = numberOrNull(body.amountExVat) || 0;
    const vat = numberOrNull(body.vat) || 0;
    const note = trimOrNull(body.note);
    // Accept a client-supplied id so undo/redo can re-add the same row.
    const id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : makeId('other');
    const [{ m }] = await sql`SELECT COALESCE(MAX(sort_order), -1) AS m FROM recurring_other_revenue`;
    await sql`
      INSERT INTO recurring_other_revenue (id, label, note, amount_ex_vat, vat, sort_order)
      VALUES (${id}, ${label}, ${note}, ${amount}, ${vat}, ${m + 1})
      ON CONFLICT (id) DO NOTHING`;
    return res.status(200).json({ ok: true, id, rows: await fetchRecurringOther() });
  }

  if (req.method === 'PATCH') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    const [existing] = await sql`SELECT * FROM recurring_other_revenue WHERE id = ${action}`;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const label = body.label !== undefined ? (trimOrNull(body.label) || existing.label) : existing.label;
    const note = body.note !== undefined ? trimOrNull(body.note) : existing.note;
    const amount = body.amountExVat !== undefined ? (numberOrNull(body.amountExVat) || 0) : existing.amount_ex_vat;
    const vat = body.vat !== undefined ? (numberOrNull(body.vat) || 0) : existing.vat;
    await sql`
      UPDATE recurring_other_revenue
         SET label = ${label}, note = ${note}, amount_ex_vat = ${amount}, vat = ${vat}
       WHERE id = ${action}`;
    return res.status(200).json({ ok: true, rows: await fetchRecurringOther() });
  }

  if (req.method === 'DELETE') {
    if (!action) return res.status(400).json({ error: 'id required' });
    // Archive the full row first so the CRM undo/redo can restore it (same id).
    const [existing] = await sql`SELECT * FROM recurring_other_revenue WHERE id = ${action}`;
    if (existing) {
      await archiveRecord('recurring_other', action, [{ table: 'recurring_other_revenue', row: existing }], actor);
      await sql`DELETE FROM recurring_other_revenue WHERE id = ${action}`;
    }
    return res.status(200).json({ ok: true, rows: await fetchRecurringOther() });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ────────────────────────────────────────────────────────────────────────────
// Directors expenses (Finance → Performance → Directors). Visible only to the two
// company directors — gated purely on email (other finance.manage users are
// excluded). Each director logs ad-hoc spend against a £250/month allowance, with
// only underspend rolling into the next month, an ongoing balancing adjustment,
// and one attachable invoice/receipt file per expense (bundled to a ZIP for Hubdoc).
// ────────────────────────────────────────────────────────────────────────────

const DIRECTOR_EMAILS = new Set(['adam@squideo.co.uk', 'ben@squideo.co.uk']);
const DIRECTOR_ALLOWANCE = 250; // £/month base, refreshed each month
const isDirector = (email) => DIRECTOR_EMAILS.has(String(email || '').toLowerCase());
// A DATE column comes back as either a 'YYYY-MM-DD' string or a Date depending on
// the driver's type parser — normalise to 'YYYY-MM-DD' (or null) for both.
const dateKey = (v) => (v == null ? null : (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10)));

let directorEnsured = null;
function ensureDirectorExpenses() {
  if (directorEnsured) return directorEnsured;
  directorEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS director_expenses (
        id             TEXT PRIMARY KEY,
        director_email TEXT NOT NULL,
        description    TEXT NOT NULL,
        amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
        vattable       BOOLEAN NOT NULL DEFAULT false,
        spent_on       DATE,
        month          TEXT NOT NULL,
        blob_url       TEXT,
        blob_pathname  TEXT,
        filename       TEXT,
        mime_type      TEXT,
        size_bytes     INTEGER,
        created_by     TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_director_expenses_month ON director_expenses (month)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_director_expenses_email ON director_expenses (director_email)`;
    // Recurring expenses: a row that repeats every month from `month` onward
    // (until `effective_to`, if set). One-offs have recurring = false.
    await sql`ALTER TABLE director_expenses ADD COLUMN IF NOT EXISTS recurring BOOLEAN NOT NULL DEFAULT false`;
    await sql`ALTER TABLE director_expenses ADD COLUMN IF NOT EXISTS effective_to TEXT`;
    // Manual drag-ordering within a director's list.
    await sql`ALTER TABLE director_expenses ADD COLUMN IF NOT EXISTS sort_order INT`;
    // "Scanned" = receipt already entered straight into Xero, so no need to
    // attach one here (just a status tag, like vattable).
    await sql`ALTER TABLE director_expenses ADD COLUMN IF NOT EXISTS scanned BOOLEAN NOT NULL DEFAULT false`;
    await sql`
      CREATE TABLE IF NOT EXISTS director_settings (
        director_email TEXT PRIMARY KEY,
        balance_adjust NUMERIC(12,2) NOT NULL DEFAULT 0,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    // Itemised balancing amounts: the standing grant is now a list of entries
    // (each with a note for what it covers) that SUM to the director's total
    // balance — functionally identical to the old single number. One row per
    // grant line.
    await sql`
      CREATE TABLE IF NOT EXISTS director_balance_items (
        id             TEXT PRIMARY KEY,
        director_email TEXT NOT NULL,
        amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
        note           TEXT,
        created_by     TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_director_balance_items_email ON director_balance_items (director_email)`;
    // Each grant is injected in a specific month ('YYYY-MM'): it raises that
    // month's allowance and any unused portion then rolls forward like the £250
    // (so it accumulates). Backfill existing rows from their created month.
    await sql`ALTER TABLE director_balance_items ADD COLUMN IF NOT EXISTS month TEXT`;
    await sql`UPDATE director_balance_items SET month = to_char(created_at, 'YYYY-MM') WHERE month IS NULL`;
    // Migrate the legacy single balance_adjust into one itemised entry, then zero
    // the column so the two never double-count. Idempotent: once the column is 0
    // there's nothing left to migrate (and the deterministic id can't duplicate).
    // The id MUST be URL-safe (it's a path segment for edit/delete) — md5(email)
    // is hex, unlike the raw email which has @/. that break routing.
    await sql`
      INSERT INTO director_balance_items (id, director_email, amount, note, month, created_at)
      SELECT 'bal-' || md5(director_email), director_email, balance_adjust, 'Balancing amount', to_char(NOW(), 'YYYY-MM'), NOW()
        FROM director_settings WHERE balance_adjust <> 0
      ON CONFLICT (id) DO NOTHING`;
    await sql`UPDATE director_settings SET balance_adjust = 0 WHERE balance_adjust <> 0`;
    // Repair earlier-migrated rows keyed as 'legacy-<email>' — the @/. in the
    // email made the path un-routable, so those lines couldn't be edited/deleted.
    await sql`UPDATE director_balance_items SET id = 'bal-' || md5(director_email)
               WHERE id LIKE 'legacy-%'
                 AND NOT EXISTS (SELECT 1 FROM director_balance_items b2 WHERE b2.id = 'bal-' || md5(director_balance_items.director_email))`;
  })().catch((err) => { directorEnsured = null; throw err; });
  return directorEnsured;
}

// Step from 'YYYY-MM' a-to-b inclusive, yielding each calendar month key.
function monthsBetween(fromKey, toKey) {
  const out = [];
  let [y, m] = fromKey.split('-').map(Number);
  const [ty, tm] = toKey.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// Is a row counted in month `mk`? One-offs apply only in their own month; a
// recurring row applies every month from its start `month` up to `effective_to`
// (inclusive) if set, else indefinitely.
function expenseActiveInMonth(r, mk) {
  if (r.recurring) return r.month <= mk && (!r.effective_to || mk <= r.effective_to);
  return r.month === mk;
}

// Roll the allowance pot for one director from `earliest` up to `month` and
// return what's available AT THE START of `month` (before that month's spend).
// Each month injects £250 + that month's new balancing grants; only underspend
// (£250 or unused grant alike) carries, so grants accumulate but nothing
// compounds beyond a simple carry:
//   avail(first) = 250 + grantIn(first)
//   avail(m)     = 250 + grantIn(m) + max(0, avail(m-1) − spent(m-1))
// `spentIn(mk)`/`grantIn(mk)` return that month's spend / newly-granted balance.
function availableFold(spentIn, grantIn, earliest, month) {
  const start = (earliest && earliest < month) ? earliest : month;
  const span = monthsBetween(start, month);
  let avail = 0;
  for (let i = 0; i < span.length; i++) {
    const carry = i === 0 ? 0 : Math.max(0, round2(avail - spentIn(span[i - 1])));
    avail = round2(DIRECTOR_ALLOWANCE + (grantIn(span[i]) || 0) + carry);
  }
  return avail;
}

async function directorExpensesReport(month) {
  await ensureDirectorExpenses();
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : curMonthKey();

  const rows = await sql`SELECT * FROM director_expenses ORDER BY sort_order ASC NULLS LAST, spent_on DESC NULLS LAST, created_at DESC`;
  // Itemised balancing grants — each tied to the month it was added. A grant
  // raises that month's allowance; unused balance then rolls forward with the
  // £250. Group by email→month (the per-month injected total) and keep the
  // selected month's lines for display.
  const balItems = await sql`SELECT id, director_email, amount, note, month, created_at FROM director_balance_items ORDER BY created_at ASC`;
  const grantByEmailMonth = new Map();  // email → (monthKey → summed amount)
  const balItemsByEmail = new Map();    // email → array of { id, amount, note, month }
  for (const it of balItems) {
    const key = it.director_email.toLowerCase();
    const mk = it.month || (it.created_at ? dateKey(it.created_at).slice(0, 7) : null);
    const amt = Number(it.amount) || 0;
    if (!balItemsByEmail.has(key)) balItemsByEmail.set(key, []);
    balItemsByEmail.get(key).push({ id: it.id, amount: amt, note: it.note || '', month: mk });
    if (!grantByEmailMonth.has(key)) grantByEmailMonth.set(key, new Map());
    const byMonth = grantByEmailMonth.get(key);
    byMonth.set(mk, round2((byMonth.get(mk) || 0) + amt));
  }

  const userRows = await sql`SELECT email, name, avatar FROM users`;
  const userByEmail = new Map(userRows.map((u) => [u.email.toLowerCase(), u]));
  const nameFor = (email) => {
    const u = userByEmail.get(email.toLowerCase());
    if (u && u.name) return u.name;
    const local = email.split('@')[0];
    return local.charAt(0).toUpperCase() + local.slice(1);
  };

  const directors = [...DIRECTOR_EMAILS].map((email) => {
    const mine = rows.filter((r) => r.director_email.toLowerCase() === email);
    const spentIn = (mk) => mine.reduce((s, r) => s + (expenseActiveInMonth(r, mk) ? (Number(r.amount) || 0) : 0), 0);
    const grantMonths = grantByEmailMonth.get(email) || new Map();
    const grantIn = (mk) => grantMonths.get(mk) || 0;
    // Start the fold at the earliest month with any activity (expense OR grant).
    const activityMonths = [
      ...mine.map((r) => r.month).filter(Boolean),
      ...grantMonths.keys(),
    ].filter(Boolean).sort();
    const earliest = activityMonths[0] || m;

    const spent = spentIn(m);
    const balanceThisMonth = round2(grantIn(m));
    // Allowance available this month = £250 + grants added this month + everything
    // (unused £250 + unused grant) rolled in from prior months. The headline and
    // the "spent of X" figure both reflect this.
    const baseAvailable = availableFold(spentIn, grantIn, earliest, m);
    const monthlyRemaining = round2(baseAvailable - spent);
    // The portion rolled in from previous months (i.e. not this month's fresh
    // £250 or this month's new grant) — shown as "carried over".
    const carriedIn = round2(Math.max(0, baseAvailable - DIRECTOR_ALLOWANCE - balanceThisMonth));
    const available = baseAvailable;
    const remaining = monthlyRemaining;

    // Honour the manual drag order (rows already sorted by sort_order above).
    const expenses = mine.filter((r) => expenseActiveInMonth(r, m)).map((r) => ({
      id: r.id,
      description: r.description,
      amount: Number(r.amount) || 0,
      vattable: !!r.vattable,
      recurring: !!r.recurring,
      scanned: !!r.scanned,
      spentOn: dateKey(r.spent_on),
      hasInvoice: !!r.blob_url,
      filename: r.filename || null,
      createdBy: r.created_by || null,
    }));

    // Only this month's grant lines are editable here (others belong to their
    // own month, just like expenses); their amounts are already folded into the
    // carried-over figure.
    const balanceItems = (balItemsByEmail.get(email) || []).filter((it) => it.month === m);
    return { email, name: nameFor(email), allowance: DIRECTOR_ALLOWANCE, carriedIn, baseAvailable, balanceThisMonth, balanceItems, monthlyRemaining, available, spent, remaining, expenses };
  });

  // "Difference" mirrors the sheet: first director's remaining minus the second.
  const difference = (directors[0]?.remaining || 0) - (directors[1]?.remaining || 0);
  return { month: m, allowance: DIRECTOR_ALLOWANCE, directors, difference };
}

// GET /director-expenses[/<YYYY-MM>] · POST add · PATCH /:id · DELETE /:id
async function directorExpensesRoute(req, res, action, user) {
  await ensureDirectorExpenses();
  const actor = (user?.email || '').toLowerCase();

  if (req.method === 'GET') {
    return res.status(200).json(await directorExpensesReport(action));
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    // Drag-reorder: persist the given ids in their new order (sort_order = index).
    if (Array.isArray(body.reorder)) {
      let i = 0;
      for (const rid of body.reorder) {
        if (typeof rid !== 'string') continue;
        await sql`UPDATE director_expenses SET sort_order = ${i}, updated_at = NOW() WHERE id = ${rid}`;
        i += 1;
      }
      return res.status(200).json({ ok: true });
    }
    const description = trimOrNull(body.description);
    if (!description) return res.status(400).json({ error: 'description required' });
    let email = String(body.director_email || body.directorEmail || '').toLowerCase();
    if (!isDirector(email)) email = actor; // default to the logged-in director
    const amount = Number(body.amount) || 0;
    const vattable = body.vattable === true;
    const recurring = body.recurring === true;
    const scanned = body.scanned === true;
    const spentOn = trimOrNull(body.spentOn) || null;
    const month = (spentOn && /^\d{4}-\d{2}/.test(spentOn)) ? spentOn.slice(0, 7) : curMonthKey();
    const id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : makeId('de');
    // New rows append to this director's list.
    const [{ m: maxOrder }] = await sql`SELECT COALESCE(MAX(sort_order), -1) AS m FROM director_expenses WHERE director_email = ${email}`;
    await sql`
      INSERT INTO director_expenses (id, director_email, description, amount, vattable, recurring, scanned, spent_on, month, sort_order, created_by)
      VALUES (${id}, ${email}, ${description}, ${amount}, ${vattable}, ${recurring}, ${scanned}, ${spentOn}, ${month}, ${maxOrder + 1}, ${actor})
      ON CONFLICT (id) DO NOTHING`;
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === 'PATCH') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const [existing] = await sql`SELECT * FROM director_expenses WHERE id = ${action}`;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    const description = body.description !== undefined ? (trimOrNull(body.description) || existing.description) : existing.description;
    const amount = body.amount !== undefined ? (Number(body.amount) || 0) : existing.amount;
    const vattable = body.vattable !== undefined ? (body.vattable === true) : existing.vattable;
    const recurring = body.recurring !== undefined ? (body.recurring === true) : existing.recurring;
    const scanned = body.scanned !== undefined ? (body.scanned === true) : existing.scanned;
    // effectiveTo ends a recurring expense from a given month (or null to clear).
    const effectiveTo = body.effectiveTo !== undefined ? (/^\d{4}-\d{2}$/.test(body.effectiveTo || '') ? body.effectiveTo : null) : existing.effective_to;
    const spentOn = body.spentOn !== undefined ? (trimOrNull(body.spentOn) || null) : dateKey(existing.spent_on);
    const month = (spentOn && /^\d{4}-\d{2}/.test(spentOn)) ? spentOn.slice(0, 7) : existing.month;
    await sql`
      UPDATE director_expenses
         SET description = ${description}, amount = ${amount}, vattable = ${vattable}, recurring = ${recurring}, scanned = ${scanned}, effective_to = ${effectiveTo}, spent_on = ${spentOn}, month = ${month}, updated_at = NOW()
       WHERE id = ${action}`;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const [existing] = await sql`SELECT blob_url FROM director_expenses WHERE id = ${action}`;
    if (existing?.blob_url) { try { await del(existing.blob_url); } catch (err) { console.error('[director-expenses] blob delete failed', err.message); } }
    await sql`DELETE FROM director_expenses WHERE id = ${action}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// POST /director-invoice/<expenseId>  (raw binary, x-filename header) · GET → download url · DELETE
async function directorInvoiceRoute(req, res, action, user) {
  await ensureDirectorExpenses();
  if (!action) return res.status(400).json({ error: 'expense id required' });
  const [row] = await sql`SELECT * FROM director_expenses WHERE id = ${action}`;
  if (!row) return res.status(404).json({ error: 'Expense not found' });

  if (req.method === 'POST') {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'File storage not configured' });
    const filename = decodeURIComponent(req.headers['x-filename'] || 'invoice');
    const mimeType = req.headers['content-type'] || 'application/octet-stream';
    let fileBuffer = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (!fileBuffer) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      fileBuffer = Buffer.concat(chunks);
    }
    if (!fileBuffer || fileBuffer.length === 0) return res.status(400).json({ error: 'No file data received' });
    if (fileBuffer.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 20 MB)' });
    // Replace any existing invoice on this expense.
    if (row.blob_url) { try { await del(row.blob_url); } catch (err) { console.error('[director-invoice] old blob delete failed', err.message); } }
    const fileId = crypto.randomUUID();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put(`director-invoices/${action}/${fileId}/${safeName}`, fileBuffer, { access: 'private', contentType: mimeType });
    await sql`
      UPDATE director_expenses
         SET blob_url = ${blob.url}, blob_pathname = ${blob.pathname}, filename = ${filename}, mime_type = ${mimeType}, size_bytes = ${fileBuffer.length}, updated_at = NOW()
       WHERE id = ${action}`;
    return res.status(201).json({ ok: true, filename, hasInvoice: true });
  }

  if (req.method === 'GET') {
    if (!row.blob_url) return res.status(404).json({ error: 'No invoice attached' });
    // The Blob store is private — its raw URL 403s, so stream the bytes back
    // through here (read server-side, like the ZIP route) and let the browser
    // display it inline. See [[project_blob_private]].
    const result = await blobGet(row.blob_url || row.blob_pathname, { access: 'private' });
    if (!result || !result.stream) return res.status(404).json({ error: 'Invoice file missing' });
    const data = Buffer.from(await new Response(result.stream).arrayBuffer());
    const filename = (row.filename || 'invoice').replace(/"/g, '');
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).end(data);
  }

  if (req.method === 'DELETE') {
    if (row.blob_url) { try { await del(row.blob_url); } catch (err) { console.error('[director-invoice] blob delete failed', err.message); } }
    await sql`
      UPDATE director_expenses
         SET blob_url = NULL, blob_pathname = NULL, filename = NULL, mime_type = NULL, size_bytes = NULL, updated_at = NOW()
       WHERE id = ${action}`;
    return res.status(200).json({ ok: true, hasInvoice: false });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// GET /director-zip/<YYYY-MM> — bundle every invoice for the month into one ZIP.
async function directorZipRoute(req, res, action) {
  await ensureDirectorExpenses();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const month = /^\d{4}-\d{2}$/.test(action || '') ? action : curMonthKey();
  // Recurring-aware: include any expense active in this month (its own month, or a
  // recurring row spanning it) that has an invoice attached.
  const all = await sql`SELECT * FROM director_expenses WHERE blob_url IS NOT NULL ORDER BY director_email, spent_on NULLS LAST`;
  const rows = all.filter((r) => expenseActiveInMonth(r, month));
  if (rows.length === 0) return res.status(404).json({ error: 'No invoices for this month' });

  const userRows = await sql`SELECT email, name FROM users`;
  const nameByEmail = new Map(userRows.map((u) => [u.email.toLowerCase(), u.name]));
  const dirName = (email) => (nameByEmail.get(email.toLowerCase()) || email.split('@')[0]).replace(/[^a-zA-Z0-9]+/g, '');

  const files = [];
  for (const r of rows) {
    try {
      const result = await blobGet(r.blob_url || r.blob_pathname, { access: 'private' });
      if (!result || !result.stream) continue;
      const data = Buffer.from(await new Response(result.stream).arrayBuffer());
      const orig = r.filename || 'invoice';
      const dot = orig.lastIndexOf('.');
      const ext = dot > 0 ? orig.slice(dot) : '';
      const desc = String(r.description || 'expense').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
      files.push({ name: `${dirName(r.director_email)}_${desc}_${r.id}${ext}`, data });
    } catch (err) {
      console.error('[director-zip] failed to read blob', r.id, err.message);
    }
  }
  if (files.length === 0) return res.status(502).json({ error: 'Could not read any invoices' });

  const zip = zipStore(files);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="director-expenses-${month}.zip"`);
  res.setHeader('Content-Length', String(zip.length));
  return res.status(200).end(zip);
}

// Balancing amounts are itemised — each a line with an amount, a note, and the
// month it's granted in. A grant raises that month's allowance and any unused
// part rolls forward like the £250 (so it accumulates).
//   POST   /director-balance            { email, id, amount, note, month } — add
//   PATCH  /director-balance/<id>       { amount?, note? }                 — edit
//   DELETE /director-balance/<id>                                          — remove
async function directorBalanceRoute(req, res, action, user) {
  await ensureDirectorExpenses();
  const itemId = action ? String(action) : null;
  const actor = (user?.email || '').toLowerCase() || null;

  if (req.method === 'POST' && !itemId) {
    const body = req.body || {};
    const email = String(body.email || '').toLowerCase();
    if (!isDirector(email)) return res.status(400).json({ error: 'Unknown director' });
    const id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : makeId('db');
    const amount = round2(Number(body.amount) || 0);
    const note = (body.note == null ? '' : String(body.note)).slice(0, 300);
    const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : curMonthKey();
    await sql`
      INSERT INTO director_balance_items (id, director_email, amount, note, month, created_by, created_at)
      VALUES (${id}, ${email}, ${amount}, ${note}, ${month}, ${actor}, NOW())
      ON CONFLICT (id) DO NOTHING`;
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === 'PATCH' && itemId) {
    const [existing] = await sql`SELECT * FROM director_balance_items WHERE id = ${itemId}`;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    const amount = body.amount !== undefined ? round2(Number(body.amount) || 0) : existing.amount;
    const note = body.note !== undefined ? (body.note == null ? '' : String(body.note)).slice(0, 300) : existing.note;
    await sql`UPDATE director_balance_items SET amount = ${amount}, note = ${note} WHERE id = ${itemId}`;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE' && itemId) {
    await sql`DELETE FROM director_balance_items WHERE id = ${itemId}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── Savings & balances + tax pay dates (Directors tab, below the expenses) ──
let directorFinanceEnsured = null;
function ensureDirectorFinance() {
  if (directorFinanceEnsured) return directorFinanceEnsured;
  directorFinanceEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS director_savings_accounts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        balance     NUMERIC(12,2) NOT NULL DEFAULT 0,
        sort_order  INT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS director_savings_pots (
        id          TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL REFERENCES director_savings_accounts(id) ON DELETE CASCADE,
        label       TEXT NOT NULL,
        amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
        note        TEXT,
        sort_order  INT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_savings_pots_account ON director_savings_pots (account_id)`;
    await sql`
      CREATE TABLE IF NOT EXISTS director_tax_payments (
        id                    TEXT PRIMARY KEY,
        title                 TEXT NOT NULL,
        kind                  TEXT,
        due_date              DATE NOT NULL,
        amount                NUMERIC(12,2) NOT NULL DEFAULT 0,
        reference             TEXT,
        note                  TEXT,
        reminded_transfer1_at TIMESTAMPTZ,
        reminded_transfer2_at TIMESTAMPTZ,
        sort_order            INT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_tax_payments_due ON director_tax_payments (due_date)`;
    // Group payments by who they're for; back-fill legacy rows from the title.
    await sql`ALTER TABLE director_tax_payments ADD COLUMN IF NOT EXISTS person TEXT`;
    await sql`
      UPDATE director_tax_payments
         SET person = CASE
                        WHEN title ILIKE '%adam%' THEN 'adam'
                        WHEN title ILIKE '%ben%'  THEN 'ben'
                        ELSE 'company'
                      END
       WHERE person IS NULL`;
    // Each director's constant HMRC personal-tax reference, so it's pre-filled.
    await sql`
      CREATE TABLE IF NOT EXISTS director_tax_refs (
        person      TEXT PRIMARY KEY,
        reference   TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
  })().catch((err) => { directorFinanceEnsured = null; throw err; });
  return directorFinanceEnsured;
}

// GET → accounts (each with nested pots, allocated subtotal + grand total).
// POST {type:'account'|'pot', …} add · {reorder,type} drag-order · PATCH/:id · DELETE/:id
async function directorSavingsRoute(req, res, action) {
  await ensureDirectorFinance();

  if (req.method === 'GET') {
    const accounts = await sql`SELECT * FROM director_savings_accounts ORDER BY sort_order ASC NULLS LAST, created_at ASC`;
    const pots = await sql`SELECT * FROM director_savings_pots ORDER BY sort_order ASC NULLS LAST, created_at ASC`;
    let grandTotal = 0;
    const out = accounts.map((a) => {
      const mine = pots.filter((p) => p.account_id === a.id).map((p) => ({
        id: p.id, label: p.label, amount: Number(p.amount) || 0, note: p.note || null,
      }));
      // The account total is simply the sum of its pots — every pound saved
      // lives in a pot (use a catch-all "Regular Savings" pot for the rest), so
      // deleting/editing a pot moves the headline straight away.
      const allocated = round2(mine.reduce((s, p) => s + p.amount, 0));
      const balance = allocated;
      grandTotal = round2(grandTotal + balance);
      return { id: a.id, name: a.name, balance, pots: mine, allocated, unallocated: 0 };
    });
    return res.status(200).json({ accounts: out, grandTotal });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const type = body.type;
    // Drag-reorder accounts or pots: persist the given ids in their new order.
    if (Array.isArray(body.reorder)) {
      const table = type === 'pot' ? 'director_savings_pots' : 'director_savings_accounts';
      let i = 0;
      for (const rid of body.reorder) {
        if (typeof rid !== 'string') continue;
        if (table === 'director_savings_pots') await sql`UPDATE director_savings_pots SET sort_order = ${i}, updated_at = NOW() WHERE id = ${rid}`;
        else await sql`UPDATE director_savings_accounts SET sort_order = ${i}, updated_at = NOW() WHERE id = ${rid}`;
        i += 1;
      }
      return res.status(200).json({ ok: true });
    }
    if (type === 'account') {
      const name = trimOrNull(body.name);
      if (!name) return res.status(400).json({ error: 'name required' });
      const balance = Number(body.balance) || 0;
      const id = makeId('sav');
      const [{ m: maxOrder }] = await sql`SELECT COALESCE(MAX(sort_order), -1) AS m FROM director_savings_accounts`;
      await sql`INSERT INTO director_savings_accounts (id, name, balance, sort_order) VALUES (${id}, ${name}, ${balance}, ${maxOrder + 1})`;
      return res.status(200).json({ ok: true, id });
    }
    if (type === 'pot') {
      const accountId = trimOrNull(body.accountId);
      const label = trimOrNull(body.label);
      if (!accountId || !label) return res.status(400).json({ error: 'accountId and label required' });
      const [acct] = await sql`SELECT id FROM director_savings_accounts WHERE id = ${accountId}`;
      if (!acct) return res.status(404).json({ error: 'Account not found' });
      const amount = Number(body.amount) || 0;
      const note = trimOrNull(body.note) || null;
      const id = makeId('pot');
      const [{ m: maxOrder }] = await sql`SELECT COALESCE(MAX(sort_order), -1) AS m FROM director_savings_pots WHERE account_id = ${accountId}`;
      await sql`INSERT INTO director_savings_pots (id, account_id, label, amount, note, sort_order) VALUES (${id}, ${accountId}, ${label}, ${amount}, ${note}, ${maxOrder + 1})`;
      return res.status(200).json({ ok: true, id });
    }
    return res.status(400).json({ error: 'Unknown type' });
  }

  if (req.method === 'PATCH') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const body = req.body || {};
    if (body.type === 'pot') {
      const [existing] = await sql`SELECT * FROM director_savings_pots WHERE id = ${action}`;
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const label = body.label !== undefined ? (trimOrNull(body.label) || existing.label) : existing.label;
      const amount = body.amount !== undefined ? (Number(body.amount) || 0) : existing.amount;
      const note = body.note !== undefined ? (trimOrNull(body.note) || null) : existing.note;
      await sql`UPDATE director_savings_pots SET label = ${label}, amount = ${amount}, note = ${note}, updated_at = NOW() WHERE id = ${action}`;
      return res.status(200).json({ ok: true });
    }
    const [existing] = await sql`SELECT * FROM director_savings_accounts WHERE id = ${action}`;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const name = body.name !== undefined ? (trimOrNull(body.name) || existing.name) : existing.name;
    const balance = body.balance !== undefined ? (Number(body.balance) || 0) : existing.balance;
    await sql`UPDATE director_savings_accounts SET name = ${name}, balance = ${balance}, updated_at = NOW() WHERE id = ${action}`;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const type = (req.query && req.query.type) || (req.body || {}).type;
    if (type === 'pot') await sql`DELETE FROM director_savings_pots WHERE id = ${action}`;
    else await sql`DELETE FROM director_savings_accounts WHERE id = ${action}`; // cascades to pots
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// GET → upcoming tax payments (sorted by due date). POST add · {reorder} · PATCH/:id · DELETE/:id
const TAX_KINDS = new Set(['vat', 'corp_tax', 'personal_tax', 'other']);
const TAX_PERSONS = new Set(['adam', 'ben', 'company']);
const TAX_PERSON_NAMES = { adam: 'Adam', ben: 'Ben', company: 'Company' };
const TAX_KIND_LABELS = { vat: 'VAT', corp_tax: 'Corp Tax', personal_tax: 'Personal Tax', other: 'Other' };
// Auto-build a readable title from kind + person so neither has to be typed.
function deriveTaxTitle(kind, person) {
  const k = TAX_KIND_LABELS[kind] || 'Payment';
  return person === 'adam' || person === 'ben' ? `${k} — ${TAX_PERSON_NAMES[person]}` : k;
}
// Keep a director's saved personal-tax reference in step with the latest entry.
async function saveTaxRef(person, kind, reference) {
  if (kind !== 'personal_tax' || (person !== 'adam' && person !== 'ben') || !reference) return;
  await sql`
    INSERT INTO director_tax_refs (person, reference, updated_at) VALUES (${person}, ${reference}, NOW())
    ON CONFLICT (person) DO UPDATE SET reference = EXCLUDED.reference, updated_at = NOW()`;
}
async function directorTaxRoute(req, res, action) {
  await ensureDirectorFinance();

  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM director_tax_payments ORDER BY due_date ASC, sort_order ASC NULLS LAST, created_at ASC`;
    const payments = rows.map((r) => ({
      id: r.id, title: r.title, kind: r.kind || 'other', person: TAX_PERSONS.has(r.person) ? r.person : 'company',
      dueDate: dateKey(r.due_date),
      amount: Number(r.amount) || 0, reference: r.reference || null, note: r.note || null,
    }));
    const refRows = await sql`SELECT person, reference FROM director_tax_refs`;
    const refs = {};
    for (const r of refRows) refs[r.person] = r.reference || null;
    return res.status(200).json({ payments, refs });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (Array.isArray(body.reorder)) {
      let i = 0;
      for (const rid of body.reorder) {
        if (typeof rid !== 'string') continue;
        await sql`UPDATE director_tax_payments SET sort_order = ${i}, updated_at = NOW() WHERE id = ${rid}`;
        i += 1;
      }
      return res.status(200).json({ ok: true });
    }
    const dueDate = trimOrNull(body.dueDate);
    if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'valid dueDate required' });
    const kind = TAX_KINDS.has(body.kind) ? body.kind : 'other';
    const person = TAX_PERSONS.has(body.person) ? body.person : 'company';
    const title = trimOrNull(body.title) || deriveTaxTitle(kind, person);
    const amount = Number(body.amount) || 0;
    const reference = trimOrNull(body.reference) || null;
    const note = trimOrNull(body.note) || null;
    const id = makeId('tax');
    const [{ m: maxOrder }] = await sql`SELECT COALESCE(MAX(sort_order), -1) AS m FROM director_tax_payments`;
    await sql`
      INSERT INTO director_tax_payments (id, title, kind, person, due_date, amount, reference, note, sort_order)
      VALUES (${id}, ${title}, ${kind}, ${person}, ${dueDate}, ${amount}, ${reference}, ${note}, ${maxOrder + 1})`;
    await saveTaxRef(person, kind, reference);
    return res.status(200).json({ ok: true, id });
  }

  if (req.method === 'PATCH') {
    if (!action) return res.status(400).json({ error: 'id required' });
    const [existing] = await sql`SELECT * FROM director_tax_payments WHERE id = ${action}`;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    const kind = body.kind !== undefined ? (TAX_KINDS.has(body.kind) ? body.kind : 'other') : existing.kind;
    const person = body.person !== undefined ? (TAX_PERSONS.has(body.person) ? body.person : 'company') : (TAX_PERSONS.has(existing.person) ? existing.person : 'company');
    // An explicit title wins; otherwise keep the stored one, re-deriving it when
    // kind/person changed so the auto-title tracks the new selection.
    const title = body.title !== undefined ? (trimOrNull(body.title) || deriveTaxTitle(kind, person))
      : (kind !== existing.kind || person !== existing.person ? deriveTaxTitle(kind, person) : existing.title);
    const dueDate = body.dueDate !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '') ? body.dueDate : dateKey(existing.due_date)) : dateKey(existing.due_date);
    const amount = body.amount !== undefined ? (Number(body.amount) || 0) : existing.amount;
    const reference = body.reference !== undefined ? (trimOrNull(body.reference) || null) : existing.reference;
    const note = body.note !== undefined ? (trimOrNull(body.note) || null) : existing.note;
    // Re-arm reminders if the schedule or amount moved, so they fire afresh for the new figures.
    const reschedule = dueDate !== dateKey(existing.due_date) || (Number(amount) !== Number(existing.amount));
    if (reschedule) {
      await sql`
        UPDATE director_tax_payments
           SET title = ${title}, kind = ${kind}, person = ${person}, due_date = ${dueDate}, amount = ${amount}, reference = ${reference}, note = ${note},
               reminded_transfer1_at = NULL, reminded_transfer2_at = NULL, updated_at = NOW()
         WHERE id = ${action}`;
    } else {
      await sql`
        UPDATE director_tax_payments
           SET title = ${title}, kind = ${kind}, person = ${person}, due_date = ${dueDate}, amount = ${amount}, reference = ${reference}, note = ${note}, updated_at = NOW()
         WHERE id = ${action}`;
    }
    await saveTaxRef(person, kind, reference);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!action) return res.status(400).json({ error: 'id required' });
    await sql`DELETE FROM director_tax_payments WHERE id = ${action}`;
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

  // Directors expenses — gated purely on identity (the two company directors).
  // Sits before the finance.manage check so other finance users are excluded.
  if (id === 'director-expenses' || id === 'director-invoice' || id === 'director-zip' || id === 'director-balance' || id === 'director-savings' || id === 'director-tax') {
    if (!isDirector(user.email)) return res.status(403).json({ error: 'Directors only' });
    if (id === 'director-expenses') return directorExpensesRoute(req, res, action, user);
    if (id === 'director-invoice') return directorInvoiceRoute(req, res, action, user);
    if (id === 'director-zip') return directorZipRoute(req, res, action);
    if (id === 'director-savings') return directorSavingsRoute(req, res, action);
    if (id === 'director-tax') return directorTaxRoute(req, res, action);
    return directorBalanceRoute(req, res, action, user);
  }

  // Pending Payments (read) + predicting are also available to the narrower
  // finance.pending_payments grant (Project/Production Managers): they can see
  // every pending payment and flag any as predicted, but nothing else in here.
  const role = await getRole(user.role);
  const canFinance = hasPermission(role, 'finance.manage');
  const canPending = canFinance || hasPermission(role, 'finance.pending_payments');
  if (id === 'pending') {
    if (!canPending) return res.status(403).json({ error: 'You do not have permission to view pending payments' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return res.status(200).json(await pendingPaymentsReport());
  }
  if (id === 'predicted-payments') {
    if (!canPending) return res.status(403).json({ error: 'You do not have permission to view predicted payments' });
    return predictedPaymentsRoute(req, res, action, user);
  }

  // Everything else below is whole-business finance — Admin + Director only.
  if (!canFinance) {
    return res.status(403).json({ error: 'You do not have permission to view business finances' });
  }

  // Writable stats resources: the sales-sheet history + manual pending payments.
  if (id === 'history') {
    return historyRoute(req, res);
  }
  if (id === 'pending-manual') {
    return pendingManualRoute(req, res, action, user);
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
  if (id === 'recurring-other') {
    return recurringOtherRoute(req, res, action, user);
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

  if (id === 'income') {
    return res.status(200).json(await incomeReport(action));
  }

  if (id === 'cashflow') {
    return res.status(200).json(await cashflowReport(action));
  }

  return res.status(404).json({ error: 'Unknown stats report' });
}
