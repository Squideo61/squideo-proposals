// Single-file router for partner-programme admin endpoints.
//
//   GET    /api/partner/credits                                 — list of clients with totals
//   GET    /api/partner/clients?key=…                           — per-client detail
//   POST   /api/partner/allocations                             — log work / adjustment
//   DELETE /api/partner/allocations?id=…                        — remove an allocation
//   POST   /api/partner/subscriptions                           — create a manual subscription
//   PATCH  /api/partner/subscriptions?id=<stripe_subscription_id>  — update manual subscription
//   DELETE /api/partner/subscriptions?id=<stripe_subscription_id>  — delete manual subscription
//
// All routes require auth.
import Stripe from 'stripe';
import sql from '../_lib/db.js';
import { cors, requireAuth } from '../_lib/middleware.js';
import { getRole } from '../_lib/userRoles.js';
import { hasPermission } from '../_lib/permissions.js';
import { notifyPpMarkedPaid } from '../_lib/crm/stats.js';
import { creditTotalsForKeys } from '../_lib/partnerCredits.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  const action = String(req.query.action || '');

  try {
    if (action === 'credits') {
      if (req.method !== 'GET') return res.status(405).end();
      return await listCredits(res);
    }

    if (action === 'clients') {
      if (req.method !== 'GET') return res.status(405).end();
      const key = req.query.key ? String(req.query.key) : null;
      if (!key) return res.status(400).json({ error: 'key required' });
      return await clientDetail(res, key);
    }

    if (action === 'allocations') {
      if (req.method === 'POST')   return await logAllocation(req, res, user);
      if (req.method === 'DELETE') {
        const id = req.query.id ? String(req.query.id) : null;
        if (!id) return res.status(400).json({ error: 'id required' });
        return await deleteAllocation(res, id);
      }
      return res.status(405).end();
    }

    if (action === 'subscriptions') {
      if (req.method === 'POST')   return await createManualSubscription(req, res);
      const subId = req.query.id ? String(req.query.id) : null;
      if (!subId) return res.status(400).json({ error: 'id required' });
      if (req.method === 'PATCH')  return await patchManualSubscription(req, res, subId);
      if (req.method === 'DELETE') {
        // Deleting a subscription is destructive and admin-only.
        if (!hasPermission(await getRole(user.role), 'users.manage')) {
          return res.status(403).json({ error: 'Only admins can delete subscriptions' });
        }
        return await deleteManualSubscription(res, subId);
      }
      return res.status(405).end();
    }

    if (action === 'cancel-subscription') {
      if (req.method !== 'POST') return res.status(405).end();
      const subId = req.query.id ? String(req.query.id) : null;
      if (!subId) return res.status(400).json({ error: 'id required' });
      return await cancelSubscription(res, subId);
    }

    if (action === 'mark-month-paid') {
      if (req.method !== 'POST') return res.status(405).end();
      const subId = req.query.id ? String(req.query.id) : null;
      if (!subId) return res.status(400).json({ error: 'id required' });
      return await markMonthPaid(req, res, user, subId);
    }

    if (action === 'manual-fee') {
      if (req.method !== 'POST') return res.status(405).end();
      return await setManualFee(req, res);
    }

    if (action === 'mark-fee-paid') {
      if (req.method !== 'POST') return res.status(405).end();
      return await markFeePaid(req, res, user);
    }

    return res.status(404).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[partner]', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ─── Credit math ────────────────────────────────────────────────────────────
// Stripe-tracked subs: 1 (initial month bundled in checkout) + count of
//   recurring partner_invoices, all × credits_per_month.
// Manual subs with auto_credit=true: months elapsed since start_date (or
//   created_at) + 1, capped at canceled_at if cancelled, × credits_per_month.
// Manual subs with auto_credit=false: 0 (admin tops up via adjustments).
//
// Adjustments: kind='adjustment' rows on credit_allocations. Positive
//   credit_cost adds to "issued"; negative adds to "used".

// Partner billing tables, self-healed:
//  · partner_manual_fees  — manual monthly spend (ex-VAT) + VAT rate per partner,
//    for clients added before the fee system (no partnerExVat on a proposal).
//  · partner_fee_payments — a month marked paid for a partner: its net + VAT, so
//    it flows into income + the VAT-to-save figure via fetchPaidRows.
let partnerBillingEnsured = null;
function ensurePartnerBilling() {
  if (partnerBillingEnsured) return partnerBillingEnsured;
  partnerBillingEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS partner_manual_fees (
        client_key  TEXT PRIMARY KEY,
        monthly_net NUMERIC,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`ALTER TABLE partner_manual_fees ADD COLUMN IF NOT EXISTS vat_rate NUMERIC NOT NULL DEFAULT 0.20`;
    await sql`
      CREATE TABLE IF NOT EXISTS partner_fee_payments (
        id         TEXT PRIMARY KEY,
        client_key TEXT NOT NULL,
        month      TEXT NOT NULL,
        net        NUMERIC NOT NULL DEFAULT 0,
        vat        NUMERIC NOT NULL DEFAULT 0,
        method     TEXT,
        paid_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT,
        UNIQUE (client_key, month)
      )`;
  })().catch((err) => { partnerBillingEnsured = null; throw err; });
  return partnerBillingEnsured;
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const curMonthKey = () => new Date().toISOString().slice(0, 7);

// POST /api/partner/manual-fee { clientKey, monthlyNet?, vatRate? } — set a
// partner's manual monthly spend (ex-VAT) and/or VAT rate (fraction, e.g. 0.20).
// Only the provided fields change. Feeds the Pending Payments "Partners" figure.
async function setManualFee(req, res) {
  await ensurePartnerBilling();
  const body = req.body || {};
  const clientKey = body.clientKey ? String(body.clientKey) : null;
  if (!clientKey) return res.status(400).json({ error: 'clientKey required' });
  const hasNet = Object.prototype.hasOwnProperty.call(body, 'monthlyNet');
  const hasVat = Object.prototype.hasOwnProperty.call(body, 'vatRate');
  let net = null, vat = null;
  if (hasNet) {
    const raw = body.monthlyNet;
    net = (raw === '' || raw == null) ? null : Number(raw);
    if (net != null && (!Number.isFinite(net) || net < 0)) return res.status(400).json({ error: 'monthlyNet must be a non-negative number' });
    if (net === 0) net = null; // 0 = cleared (fall back to derived)
  }
  if (hasVat) {
    const raw = body.vatRate;
    vat = (raw === '' || raw == null) ? 0.20 : Number(raw);
    if (!Number.isFinite(vat) || vat < 0 || vat > 1) return res.status(400).json({ error: 'vatRate must be a fraction between 0 and 1' });
  }
  const [existing] = await sql`SELECT monthly_net, vat_rate FROM partner_manual_fees WHERE client_key = ${clientKey}`;
  const finalNet = hasNet ? net : (existing ? existing.monthly_net : null);
  const finalVat = hasVat ? vat : (existing ? Number(existing.vat_rate) : 0.20);
  await sql`
    INSERT INTO partner_manual_fees (client_key, monthly_net, vat_rate, updated_at)
    VALUES (${clientKey}, ${finalNet}, ${finalVat}, NOW())
    ON CONFLICT (client_key) DO UPDATE SET monthly_net = EXCLUDED.monthly_net, vat_rate = EXCLUDED.vat_rate, updated_at = NOW()`;
  return res.status(200).json({ ok: true, clientKey, monthlyNet: finalNet, vatRate: finalVat });
}

// POST /api/partner/mark-fee-paid { clientKey, month?, method?, net?, paid? } —
// mark (or, with paid:false, un-mark) a partner's monthly fee as collected for a
// month (default this month). Records net + VAT so it lands in income + VAT-to-
// save. `net` overrides the stored monthly figure for that one month if supplied.
async function markFeePaid(req, res, user) {
  await ensurePartnerBilling();
  const body = req.body || {};
  const clientKey = body.clientKey ? String(body.clientKey) : null;
  if (!clientKey) return res.status(400).json({ error: 'clientKey required' });
  const month = /^\d{4}-\d{2}$/.test(String(body.month || '')) ? String(body.month) : curMonthKey();
  const unpay = body.paid === false;

  if (unpay) {
    await sql`DELETE FROM partner_fee_payments WHERE client_key = ${clientKey} AND month = ${month}`;
    return res.status(200).json({ ok: true, clientKey, month, paid: false });
  }

  // Resolve this partner's net + VAT rate (manual override, else the derived fee).
  const [fee] = await sql`SELECT monthly_net, vat_rate FROM partner_manual_fees WHERE client_key = ${clientKey}`;
  const [derived] = await sql`
    SELECT (sg.data->'amountBreakdown'->>'partnerExVat')::numeric AS ex_vat,
           (sg.data->>'vatRate')::numeric AS rate
      FROM partner_subscriptions ps
      JOIN signatures sg ON sg.proposal_id = ps.proposal_id
     WHERE ps.client_key = ${clientKey}
       AND (sg.data->'amountBreakdown'->>'partnerExVat') IS NOT NULL
     ORDER BY sg.signed_at DESC NULLS LAST LIMIT 1`;
  const net = body.net != null && body.net !== ''
    ? Number(body.net)
    : (fee && fee.monthly_net != null ? Number(fee.monthly_net) : (derived ? Number(derived.ex_vat) : 0));
  if (!Number.isFinite(net) || net <= 0) {
    return res.status(400).json({ error: 'No monthly amount set for this partner — add one first.' });
  }
  const vatRate = fee ? Number(fee.vat_rate) : (derived && derived.rate != null ? Number(derived.rate) : 0.20);
  const vat = r2(net * vatRate);
  const method = (body.method || 'BACS').toString().slice(0, 40);

  await sql`
    INSERT INTO partner_fee_payments (id, client_key, month, net, vat, method, paid_at, created_by)
    VALUES (${'pfp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)}, ${clientKey}, ${month}, ${r2(net)}, ${vat}, ${method}, NOW(), ${user.email || null})
    ON CONFLICT (client_key, month) DO UPDATE SET net = EXCLUDED.net, vat = EXCLUDED.vat, method = EXCLUDED.method, paid_at = NOW(), created_by = EXCLUDED.created_by`;

  // Broadcast in-app alert to the sales & finance bell (best-effort).
  const [partner] = await sql`SELECT client_name FROM partner_subscriptions WHERE client_key = ${clientKey} ORDER BY created_at DESC LIMIT 1`;
  await notifyPpMarkedPaid({
    label: `${partner?.client_name || clientKey} (partner)`,
    amount: r2(net),
    method,
    actorName: user?.name || user?.email || null,
  });

  return res.status(200).json({ ok: true, clientKey, month, paid: true, net: r2(net), vat });
}

async function listCredits(res) {
  await ensurePartnerBilling();
  // Core issued/used/remaining per client (shared with the company "Current
  // Projects" view). null → every client.
  const rows = await creditTotalsForKeys(null);

  // Per-client partner monthly fee (ex-VAT) + monthly credit allocation, taken
  // from the latest signed partner proposal. Drives the £ figure shown on the
  // Finance → Pending Payments "Partners" section: a subscription contributes its
  // monthly fee; a credits-only client contributes its remaining-credit value at
  // ratePerCredit = partnerExVat / partnerCredits.
  const feeRows = await sql`
    SELECT DISTINCT ON (ps.client_key)
           ps.client_key,
           (sg.data->'amountBreakdown'->>'partnerExVat')::numeric AS partner_ex_vat,
           NULLIF(sg.data->>'partnerCredits', '')::numeric        AS partner_credits,
           NULLIF(sg.data->>'vatRate', '')::numeric               AS vat_rate
      FROM partner_subscriptions ps
      JOIN signatures sg ON sg.proposal_id = ps.proposal_id
     WHERE (sg.data->'amountBreakdown'->>'partnerExVat') IS NOT NULL
     ORDER BY ps.client_key, sg.signed_at DESC NULLS LAST
  `;
  const feeByClient = new Map(feeRows.map(r => [r.client_key, {
    exVat: Number(r.partner_ex_vat) || 0,
    credits: Number(r.partner_credits) || 0,
    rate: r.vat_rate == null ? null : Number(r.vat_rate),
  }]));
  // Manual monthly-spend + VAT-rate overrides (set by hand for pre-system partners).
  const manualFeeRows = await sql`SELECT client_key, monthly_net, vat_rate FROM partner_manual_fees`;
  const manualByClient = new Map(manualFeeRows.map(r => [r.client_key, {
    net: r.monthly_net == null ? null : Number(r.monthly_net),
    vatRate: r.vat_rate == null ? 0.20 : Number(r.vat_rate),
    hasRow: true,
  }]));
  // Which partners have this month's fee marked paid (so it's collected, not owed).
  const thisMonth = curMonthKey();
  const paidRows = await sql`SELECT client_key, net, vat FROM partner_fee_payments WHERE month = ${thisMonth}`;
  const paidByClient = new Map(paidRows.map(r => [r.client_key, { net: Number(r.net) || 0, vat: Number(r.vat) || 0 }]));

  const list = rows.map(r => {
    const creditsRemaining = Number(r.credits_remaining) || 0;
    const fee = feeByClient.get(r.client_key) || { exVat: 0, credits: 0 };
    const ratePerCredit = fee.credits > 0 ? fee.exVat / fee.credits : 0;
    const manual = manualByClient.get(r.client_key) || null;
    const manualMonthly = manual ? manual.net : null;
    const vatRate = manual ? manual.vatRate : (fee.rate != null ? fee.rate : 0.20);
    const monthlyNet = manualMonthly != null ? r2(manualMonthly) : r2(fee.exVat); // ex-VAT recurring fee
    // Base outstanding (ex-VAT): a manual override wins; otherwise subscription →
    // next month's fee, credits-only → value of credits still owed, inactive → nil.
    const baseOutstanding = manualMonthly != null
      ? r2(manualMonthly)
      : (r.status === 'active' ? monthlyNet : (r.status === 'credits_only' ? r2(creditsRemaining * ratePerCredit) : 0));
    // This month already marked paid → collected, so nothing's outstanding now.
    const paidThisMonth = paidByClient.has(r.client_key);
    const outstanding = paidThisMonth ? 0 : baseOutstanding;
    return {
      clientKey: r.client_key,
      clientName: r.client_name,
      subscriptions: { count: r.sub_count, active: r.sub_active_count },
      creditsIssued: Number(r.credits_issued) || 0,
      creditsUsed: Number(r.credits_used) || 0,
      creditsRemaining,
      lastPaymentAt: r.last_payment_at,
      status: r.status,
      monthlyNet,
      vatRate: r2(vatRate),
      monthlyVat: r2(monthlyNet * vatRate),
      ratePerCredit: r2(ratePerCredit),
      manualFee: manualMonthly != null,
      paidThisMonth,
      paidThisMonthAt: paidThisMonth ? thisMonth : null,
      outstanding,
    };
  });

  return res.status(200).json(list);
}

async function clientDetail(res, key) {
  const [subscriptions, recurring, initial, allocations] = await Promise.all([
    sql`
      SELECT
        ps.stripe_subscription_id,
        ps.proposal_id,
        ps.client_name,
        ps.credits_per_month,
        ps.status,
        ps.current_period_end,
        ps.canceled_at,
        ps.created_at,
        ps.start_date,
        ps.auto_credit,
        ps.xero_contact_id,
        ps.xero_invoice_reference,
        p.number_year,
        p.number_seq,
        (p.data->>'proposalTitle') AS proposal_title,
        (p.data->>'clientName')    AS proposal_client_name
      FROM partner_subscriptions ps
      LEFT JOIN proposals p ON p.id = ps.proposal_id
      WHERE ps.client_key = ${key}
      ORDER BY ps.created_at ASC
    `,
    sql`
      SELECT pi.stripe_invoice_id, pi.proposal_id, pi.amount, pi.paid_at,
             ps.credits_per_month
      FROM partner_invoices pi
      JOIN partner_subscriptions ps ON ps.proposal_id = pi.proposal_id
      WHERE ps.client_key = ${key}
      ORDER BY pi.paid_at ASC
    `,
    sql`
      SELECT p.proposal_id, p.amount, p.paid_at, ps.credits_per_month
      FROM payments p
      JOIN partner_subscriptions ps ON ps.proposal_id = p.proposal_id
      WHERE ps.client_key = ${key}
        AND p.partner_subscription_id IS NOT NULL
      ORDER BY p.paid_at ASC
    `,
    sql`
      SELECT id, proposal_id, description, credit_cost, kind,
             allocated_at, allocated_by, notes
      FROM credit_allocations
      WHERE client_key = ${key}
      ORDER BY allocated_at DESC, id DESC
    `,
  ]);

  if (subscriptions.length === 0) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const formatProposalNumber = (year, seq) => {
    if (!year || !seq) return null;
    return String(year) + '-' + String(seq).padStart(4, '0');
  };

  const isManual = (sid) => typeof sid === 'string' && sid.startsWith('manual_');

  const monthsElapsed = (startISO, endISO) => {
    if (!startISO) return 0;
    const start = new Date(startISO);
    const end = endISO ? new Date(endISO) : new Date();
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
    // Day-aware month diff — matches Postgres AGE() so detail and list
    // views stay in sync. If we haven't yet reached the start day-of-month
    // in the current calendar month, the current month doesn't count.
    let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    if (end.getDate() < start.getDate()) months--;
    return Math.max(0, months);
  };

  const subs = subscriptions.map(s => {
    const manual = isManual(s.stripe_subscription_id);
    let issuedFromSub;
    if (manual) {
      if (s.auto_credit) {
        const startISO = s.start_date || s.created_at;
        const endISO   = s.canceled_at || null;
        issuedFromSub = (Number(s.credits_per_month) || 0) * (monthsElapsed(startISO, endISO) + 1);
      } else {
        issuedFromSub = 0;
      }
    } else {
      const recurringCount = recurring.filter(r => r.proposal_id === s.proposal_id).length;
      issuedFromSub = (Number(s.credits_per_month) || 0) * (1 + recurringCount);
    }
    return {
      stripeSubscriptionId: s.stripe_subscription_id,
      proposalId: s.proposal_id,
      proposalNumber: formatProposalNumber(s.number_year, s.number_seq),
      proposalTitle: s.proposal_title || s.proposal_client_name,
      creditsPerMonth: Number(s.credits_per_month) || 0,
      status: s.status,
      currentPeriodEnd: s.current_period_end,
      canceledAt: s.canceled_at,
      createdAt: s.created_at,
      startDate: s.start_date,
      autoCredit: !!s.auto_credit,
      xeroContactId: s.xero_contact_id || null,
      xeroInvoiceReference: s.xero_invoice_reference || null,
      isManual: manual,
      creditsIssuedFromSub: issuedFromSub,
    };
  });

  const initialPayments = initial.map(p => ({
    paidAt: p.paid_at,
    amount: Number(p.amount) || 0,
    creditsAdded: Number(p.credits_per_month) || 0,
    source: 'initial',
    proposalId: p.proposal_id,
  }));
  const recurringPayments = recurring.map(p => ({
    paidAt: p.paid_at,
    amount: Number(p.amount) || 0,
    creditsAdded: Number(p.credits_per_month) || 0,
    source: 'recurring',
    proposalId: p.proposal_id,
  }));
  const payments = [...initialPayments, ...recurringPayments]
    .sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt));

  const allocationList = allocations.map(a => ({
    id: a.id,
    proposalId: a.proposal_id,
    description: a.description,
    creditCost: Number(a.credit_cost) || 0,
    kind: a.kind || 'work',
    allocatedAt: a.allocated_at,
    allocatedBy: a.allocated_by,
    notes: a.notes,
  }));

  // Totals: sub-issued + positive adjustments → issued; work + |negative
  // adjustments| → used.
  const subIssued = subs.reduce((s, x) => s + (x.creditsIssuedFromSub || 0), 0);
  const adjAdded   = allocationList.filter(a => a.kind === 'adjustment' && a.creditCost > 0).reduce((s, a) => s + a.creditCost, 0);
  const adjRemoved = allocationList.filter(a => a.kind === 'adjustment' && a.creditCost < 0).reduce((s, a) => s + (-a.creditCost), 0);
  const workUsed   = allocationList.filter(a => a.kind === 'work').reduce((s, a) => s + a.creditCost, 0);
  const issued = subIssued + adjAdded;
  const used = workUsed + adjRemoved;
  const remaining = issued - used;
  const usagePct = issued > 0 ? Math.min(100, Math.round((used / issued) * 1000) / 10) : 0;

  const clientName = subscriptions.find(s => s.client_name)?.client_name
    || subs[0].proposalTitle
    || key;

  // Three-way client status, matching listCredits so the detail header pill
  // agrees with the list pill.
  const anyRecurringActive = subs.some(s =>
    s.status === 'active' && (!s.isManual || (s.autoCredit && s.creditsPerMonth > 0)));
  const anyCreditsOnly = subs.some(s => s.isManual && !s.autoCredit && s.creditsPerMonth === 0);
  const status = anyRecurringActive
    ? 'active'
    : (anyCreditsOnly || remaining > 0) ? 'credits_only' : 'inactive';

  return res.status(200).json({
    clientKey: key,
    clientName,
    status,
    subscriptions: subs,
    payments,
    allocations: allocationList,
    totals: { issued, used, remaining, usagePct },
  });
}

async function logAllocation(req, res, user) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const clientKey = (body.clientKey || '').trim().toLowerCase();
  const description = (body.description || '').trim();
  const creditCost = Number(body.creditCost);
  const kindIn = String(body.kind || 'work').toLowerCase();
  const kind = kindIn === 'adjustment' ? 'adjustment' : 'work';
  const proposalId = body.proposalId ? String(body.proposalId) : null;
  const notes = body.notes ? String(body.notes).trim() : null;
  // Optional past-date support: accept ISO date (YYYY-MM-DD) or full
  // datetime. Bare dates are anchored at midday UTC so they don't shift
  // across timezones.
  let allocatedAt = null;
  if (body.allocatedAt) {
    const raw = String(body.allocatedAt);
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const d = new Date(isDateOnly ? raw + 'T12:00:00Z' : raw);
    if (!isNaN(d.getTime())) allocatedAt = d.toISOString();
  }

  if (!clientKey)         return res.status(400).json({ error: 'clientKey required' });
  if (!description)       return res.status(400).json({ error: 'description required' });
  if (!Number.isFinite(creditCost)) {
    return res.status(400).json({ error: 'creditCost must be a number' });
  }
  if (kind === 'work' && creditCost <= 0) {
    return res.status(400).json({ error: 'work credit cost must be positive' });
  }
  if (kind === 'adjustment' && creditCost === 0) {
    return res.status(400).json({ error: 'adjustment cannot be zero' });
  }

  const [exists] = await sql`
    SELECT 1 FROM partner_subscriptions WHERE client_key = ${clientKey} LIMIT 1
  `;
  if (!exists) return res.status(404).json({ error: 'client not found' });

  const [row] = await sql`
    INSERT INTO credit_allocations
      (client_key, proposal_id, description, credit_cost, kind, allocated_by, notes, allocated_at)
    VALUES
      (${clientKey}, ${proposalId}, ${description}, ${creditCost}, ${kind}, ${user.email || null}, ${notes},
       COALESCE(${allocatedAt}::TIMESTAMPTZ, NOW()))
    RETURNING id, client_key, proposal_id, description, credit_cost, kind,
              allocated_at, allocated_by, notes
  `;

  return res.status(201).json({
    id: row.id,
    clientKey: row.client_key,
    proposalId: row.proposal_id,
    description: row.description,
    creditCost: Number(row.credit_cost) || 0,
    kind: row.kind,
    allocatedAt: row.allocated_at,
    allocatedBy: row.allocated_by,
    notes: row.notes,
  });
}

async function deleteAllocation(res, id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const result = await sql`DELETE FROM credit_allocations WHERE id = ${numeric} RETURNING id`;
  if (result.length === 0) return res.status(404).json({ error: 'not found' });

  return res.status(200).json({ ok: true, id: result[0].id });
}

// ─── Manual subscriptions ───────────────────────────────────────────────────

function newManualSubId() {
  return 'manual_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function createManualSubscription(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const clientName = (body.clientName || '').trim();
  if (!clientName) return res.status(400).json({ error: 'clientName required' });
  const clientKey = clientName.toLowerCase();
  const creditsPerMonth = Number(body.creditsPerMonth);
  if (!Number.isFinite(creditsPerMonth) || creditsPerMonth < 0) {
    return res.status(400).json({ error: 'creditsPerMonth must be a non-negative number' });
  }
  const startDate = body.startDate ? String(body.startDate).slice(0, 10) : null;
  const autoCredit = body.autoCredit !== false; // default true
  const initialBalance = Number(body.initialBalance);

  const subId = newManualSubId();

  await sql`
    INSERT INTO partner_subscriptions
      (stripe_subscription_id, proposal_id, client_key, client_name,
       credits_per_month, status, start_date, auto_credit)
    VALUES
      (${subId}, NULL, ${clientKey}, ${clientName},
       ${creditsPerMonth}, 'active', ${startDate}, ${autoCredit})
  `;

  if (Number.isFinite(initialBalance) && initialBalance !== 0) {
    await sql`
      INSERT INTO credit_allocations
        (client_key, proposal_id, description, credit_cost, kind, allocated_by, notes)
      VALUES
        (${clientKey}, NULL, 'Opening balance', ${initialBalance}, 'adjustment', NULL, 'Set when manual subscription was created')
    `;
  }

  return res.status(201).json({ ok: true, stripeSubscriptionId: subId, clientKey });
}

async function patchManualSubscription(req, res, subId) {
  if (!subId.startsWith('manual_')) {
    return res.status(400).json({ error: 'only manual subscriptions can be patched' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // We deliberately do NOT change client_key on rename — that would orphan
  // past allocations. Only the display name (client_name) is editable.

  const updates = [];
  if (typeof body.creditsPerMonth === 'number' && Number.isFinite(body.creditsPerMonth) && body.creditsPerMonth >= 0) {
    updates.push(sql`UPDATE partner_subscriptions SET credits_per_month = ${body.creditsPerMonth}, updated_at = NOW() WHERE stripe_subscription_id = ${subId}`);
  }
  if (typeof body.autoCredit === 'boolean') {
    updates.push(sql`UPDATE partner_subscriptions SET auto_credit = ${body.autoCredit}, updated_at = NOW() WHERE stripe_subscription_id = ${subId}`);
  }
  if ('startDate' in body) {
    const sd = body.startDate ? String(body.startDate).slice(0, 10) : null;
    updates.push(sql`UPDATE partner_subscriptions SET start_date = ${sd}, updated_at = NOW() WHERE stripe_subscription_id = ${subId}`);
  }
  if (typeof body.status === 'string' && ['active', 'canceled', 'inactive'].includes(body.status)) {
    const cancelTs = body.status === 'canceled' ? new Date().toISOString() : null;
    updates.push(sql`UPDATE partner_subscriptions SET status = ${body.status}, canceled_at = ${cancelTs}, updated_at = NOW() WHERE stripe_subscription_id = ${subId}`);
  }
  if (typeof body.clientName === 'string' && body.clientName.trim()) {
    updates.push(sql`UPDATE partner_subscriptions SET client_name = ${body.clientName.trim()}, updated_at = NOW() WHERE stripe_subscription_id = ${subId}`);
  }
  // Xero recurring-invoice link. Empty string clears the link.
  if ('xeroContactId' in body) {
    const v = body.xeroContactId ? String(body.xeroContactId).trim() : null;
    updates.push(sql`UPDATE partner_subscriptions SET xero_contact_id = ${v || null}, updated_at = NOW() WHERE stripe_subscription_id = ${subId}`);
  }
  if ('xeroInvoiceReference' in body) {
    const v = body.xeroInvoiceReference ? String(body.xeroInvoiceReference).trim().slice(0, 200) : null;
    updates.push(sql`UPDATE partner_subscriptions SET xero_invoice_reference = ${v || null}, updated_at = NOW() WHERE stripe_subscription_id = ${subId}`);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'no patchable fields supplied' });
  }

  for (const q of updates) await q;
  return res.status(200).json({ ok: true });
}

// Cancel a partner subscription. Manual subs are flipped to 'canceled' in
// our DB. Stripe-tracked subs additionally call the Stripe API to stop
// future billing immediately; the customer.subscription.deleted webhook
// will land shortly and refresh canceled_at.
async function cancelSubscription(res, subId) {
  const [row] = await sql`
    SELECT stripe_subscription_id, status FROM partner_subscriptions
    WHERE stripe_subscription_id = ${subId}
  `;
  if (!row) return res.status(404).json({ error: 'subscription not found' });
  if (row.status === 'canceled') return res.status(200).json({ ok: true, alreadyCanceled: true });

  const isManual = subId.startsWith('manual_');

  if (!isManual) {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
    }
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.cancel(subId);
    } catch (err) {
      console.error('[partner] stripe cancel failed', err);
      return res.status(502).json({ error: 'Stripe cancellation failed: ' + (err?.message || 'unknown') });
    }
  }

  await sql`
    UPDATE partner_subscriptions
    SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
    WHERE stripe_subscription_id = ${subId}
  `;

  return res.status(200).json({ ok: true });
}

// One-click "this month's invoice was paid" — records the subscription's
// credits_per_month as a positive adjustment, dated today. Used for BACS (and
// any payment Xero didn't auto-detect). Mirrors how the Xero webhook credits,
// but is operator-initiated and labelled as a manual payment.
async function markMonthPaid(req, res, user, subId) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const [sub] = await sql`
    SELECT client_key, client_name, credits_per_month, status
      FROM partner_subscriptions WHERE stripe_subscription_id = ${subId}
  `;
  if (!sub) return res.status(404).json({ error: 'subscription not found' });

  const credits = Number(sub.credits_per_month) || 0;
  if (credits <= 0) {
    return res.status(400).json({ error: 'Set a "credits per month" amount on this subscription first.' });
  }

  // Bare date (YYYY-MM-DD) anchored midday UTC so it doesn't drift timezone.
  let allocatedAt = null;
  if (body.date) {
    const raw = String(body.date);
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const d = new Date(isDateOnly ? raw + 'T12:00:00Z' : raw);
    if (!isNaN(d.getTime())) allocatedAt = d.toISOString();
  }
  const method = (body.method || 'BACS').toString().slice(0, 40);

  const [row] = await sql`
    INSERT INTO credit_allocations
      (client_key, proposal_id, description, credit_cost, kind, allocated_by, notes, allocated_at)
    VALUES
      (${sub.client_key}, NULL, 'Monthly subscription payment', ${credits}, 'adjustment',
       ${user.email || null}, ${'Marked paid manually (' + method + ')'},
       COALESCE(${allocatedAt}::TIMESTAMPTZ, NOW()))
    RETURNING id, client_key, proposal_id, description, credit_cost, kind,
              allocated_at, allocated_by, notes
  `;

  return res.status(201).json({
    id: row.id,
    clientKey: row.client_key,
    proposalId: row.proposal_id,
    description: row.description,
    creditCost: Number(row.credit_cost) || 0,
    kind: row.kind,
    allocatedAt: row.allocated_at,
    allocatedBy: row.allocated_by,
    notes: row.notes,
  });
}

async function deleteManualSubscription(res, subId) {
  if (!subId.startsWith('manual_')) {
    return res.status(400).json({ error: 'only manual subscriptions can be deleted' });
  }
  const result = await sql`
    DELETE FROM partner_subscriptions WHERE stripe_subscription_id = ${subId} RETURNING stripe_subscription_id
  `;
  if (result.length === 0) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true });
}
