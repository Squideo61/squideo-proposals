// Staff Commission — automatic sales commission for on-plan staff.
//
// Recognition is EVENT-based (ex-VAT), per member, per month, resetting to £0
// each month. Commission on a deal's full proposal balance is granted in full at
// a trigger event, attributed to the deal owner (deals.owner_email):
//   • Normal deals — when the DEPOSIT (first payment) lands.
//   • PO-route deals (signature paymentOption 'po') — when the proposal is SIGNED.
// The base amount is the signed proposal net (computeProposalTotalExVat) plus any
// extras already on the deal at the trigger. Extras added AFTER the trigger are
// recognised individually when they're paid (deal_extras.paid_at). A deal with no
// signed proposal earns nothing. See loadRecognitionEvents.
//
// Two admin-editable bands (commission_config):
//   Band A: band_a_rate on net sales up to band_a_cap  (default 5% up to £5,000 → max £250)
//   Band B: band_b_rate on everything above the cap     (default 2%, uncapped)

import sql from '../db.js';
import { EXCLUDED_IMPORT_DEAL_IDS } from './signedSale.js';
import { computeProposalTotalExVat } from './deals.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const monthKey = (d) => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
const curMonthKey = () => monthKey(new Date());
const isMonth = (s) => /^\d{4}-\d{2}$/.test(s || '');
const lc = (s) => (s || '').toLowerCase();

// ── Self-heal (mirrors db/migrations/20260709_staff_commission.sql) ──
let commissionEnsured = null;
export function ensureCommission() {
  if (commissionEnsured) return commissionEnsured;
  commissionEnsured = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS commission_config (
        id          INT PRIMARY KEY DEFAULT 1,
        band_a_rate NUMERIC NOT NULL DEFAULT 0.05,
        band_a_cap  NUMERIC NOT NULL DEFAULT 5000,
        band_b_rate NUMERIC NOT NULL DEFAULT 0.02,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by  TEXT
      )`;
    await sql`INSERT INTO commission_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
    await sql`
      CREATE TABLE IF NOT EXISTS commission_members (
        email          TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
        enabled        BOOLEAN NOT NULL DEFAULT TRUE,
        effective_from TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
  })().catch((err) => { commissionEnsured = null; throw err; });
  return commissionEnsured;
}

// ── Band config ──
const DEFAULT_CONFIG = { bandARate: 0.05, bandACap: 5000, bandBRate: 0.02, updatedAt: null, updatedBy: null };

export async function loadConfig() {
  await ensureCommission();
  const [r] = await sql`SELECT band_a_rate, band_a_cap, band_b_rate, updated_at, updated_by FROM commission_config WHERE id = 1`;
  if (!r) return { ...DEFAULT_CONFIG };
  return {
    bandARate: Number(r.band_a_rate),
    bandACap: Number(r.band_a_cap),
    bandBRate: Number(r.band_b_rate),
    updatedAt: r.updated_at,
    updatedBy: r.updated_by || null,
  };
}

// The band math. `net` is the member's net (ex-VAT) qualifying cash for the month.
// Band A "max earning" (£250) is derived (cap × rateA), so editing the cap/rate
// recomputes it — there's no separate cap-earning field.
export function computeCommission(net, cfg) {
  const q = Math.max(0, Number(net) || 0);
  const cap = Math.max(0, Number(cfg.bandACap) || 0);
  const bandA = round2(Math.min(q, cap) * (Number(cfg.bandARate) || 0));
  const bandB = round2(Math.max(0, q - cap) * (Number(cfg.bandBRate) || 0));
  return { qualifying: round2(q), bandA, bandB, total: round2(bandA + bandB) };
}

// ── Members ──
async function loadMembers() {
  await ensureCommission();
  return sql`
    SELECT m.email, m.enabled, m.effective_from, u.name
      FROM commission_members m
      LEFT JOIN users u ON u.email = m.email
     ORDER BY u.name NULLS LAST, m.email`;
}

// A member accrues in `month` when enabled and their effective_from is that
// month or earlier (string compare works on 'YYYY-MM').
const accruesIn = (m, month) => m.enabled !== false && String(m.effective_from) <= month;

// ── Recognition events ──
// Every commission-qualifying EVENT across all deals with a signed proposal:
//   • BASE — the full proposal net (+ any extras already on the deal at the
//     trigger), recognised in full when the DEPOSIT (first payment) lands for a
//     normal deal, or when the proposal is SIGNED for a PO-route deal.
//   • EXTRA — each PAID extra ADDED AFTER the trigger, recognised in the month
//     its cash landed (deal_extras.paid_at). Extras that existed at/before the
//     trigger are folded into BASE, so they're never counted twice.
// Deals with NO signed proposal earn nothing (no proposal balance to base on).
// Returns [{ ownerEmail, dealId, company, title, month, amount, kind, date }].
async function loadRecognitionEvents() {
  const [sigRows, payRows, extraRows] = await Promise.all([
    // Signed proposals (base candidates). data columns are JSONB → parsed objects.
    sql`SELECT d.id AS deal_id, d.owner_email, d.title, c.name AS company,
               s.signed_at, s.data AS sig_data, p.data AS prop_data
          FROM signatures s
          JOIN proposals p ON p.id = s.proposal_id
          JOIN deals d ON d.id = p.deal_id
          LEFT JOIN companies c ON c.id = d.company_id`,
    // Earliest payment per deal (the "deposit") across the proposal-linked money
    // sources — the trigger date for non-PO deals.
    sql`SELECT p.deal_id AS deal_id, MIN(x.paid_at) AS first_paid
          FROM (
            SELECT proposal_id, paid_at FROM payments WHERE paid_at IS NOT NULL
            UNION ALL SELECT proposal_id, paid_at FROM manual_payments WHERE manual_invoice_id IS NULL AND paid_at IS NOT NULL
            UNION ALL SELECT proposal_id, paid_at FROM proposal_billing WHERE paid_at IS NOT NULL
            UNION ALL SELECT proposal_id, paid_at FROM partner_invoices WHERE paid_at IS NOT NULL
          ) x
          JOIN proposals p ON p.id = x.proposal_id
         GROUP BY p.deal_id`,
    // Extras (net amounts), with the durable paid date (falls back to updated_at).
    sql`SELECT e.id, e.deal_id, e.amount, e.status, e.created_at,
               COALESCE(e.paid_at, e.updated_at) AS paid_at,
               d.owner_email, d.title, c.name AS company
          FROM deal_extras e
          JOIN deals d ON d.id = e.deal_id
          LEFT JOIN companies c ON c.id = d.company_id`,
  ]);

  const firstPaid = new Map();
  for (const r of payRows) if (r.first_paid) firstPaid.set(r.deal_id, new Date(r.first_paid));

  // Aggregate signed proposals per deal (a deal can carry more than one).
  const deals = new Map();
  for (const r of sigRows) {
    if (EXCLUDED_IMPORT_DEAL_IDS.has(r.deal_id)) continue;
    let d = deals.get(r.deal_id);
    if (!d) { d = { ownerEmail: r.owner_email, title: r.title, company: r.company, isPo: false, signedAt: null, net: 0 }; deals.set(r.deal_id, d); }
    d.net += Number(computeProposalTotalExVat(r.prop_data, r.sig_data)) || 0;
    if (r.sig_data && r.sig_data.paymentOption === 'po') d.isPo = true;
    const signedAt = r.signed_at ? new Date(r.signed_at) : null;
    if (signedAt && (!d.signedAt || signedAt < d.signedAt)) d.signedAt = signedAt;
  }

  const extrasByDeal = new Map();
  for (const r of extraRows) {
    if (!extrasByDeal.has(r.deal_id)) extrasByDeal.set(r.deal_id, []);
    extrasByDeal.get(r.deal_id).push({
      amount: Number(r.amount) || 0, status: r.status,
      createdAt: r.created_at ? new Date(r.created_at) : null,
      paidAt: r.paid_at ? new Date(r.paid_at) : null,
    });
  }

  const events = [];
  for (const [dealId, d] of deals) {
    if (!d.ownerEmail) continue;
    // Trigger: PO → when signed; else → the deposit (first payment). No trigger
    // yet (non-PO, unpaid) → no base event, but a paid extra can still recognise.
    const triggerDate = d.isPo ? d.signedAt : (firstPaid.get(dealId) || null);
    const dealExtras = extrasByDeal.get(dealId) || [];

    if (triggerDate) {
      let base = d.net;
      for (const x of dealExtras) if (x.createdAt && x.createdAt <= triggerDate) base += x.amount;
      base = round2(base);
      if (base > 0) {
        events.push({ ownerEmail: d.ownerEmail, dealId, company: d.company, title: d.title,
          month: monthKey(triggerDate), amount: base, kind: d.isPo ? 'signing' : 'deposit', date: triggerDate.toISOString() });
      }
    }

    for (const x of dealExtras) {
      if (x.status !== 'paid' || !x.paidAt || x.amount <= 0) continue;
      if (triggerDate && x.createdAt && x.createdAt <= triggerDate) continue; // folded into BASE
      events.push({ ownerEmail: d.ownerEmail, dealId, company: d.company, title: d.title,
        month: monthKey(x.paidAt), amount: round2(x.amount), kind: 'extra', date: x.paidAt.toISOString() });
    }
  }
  return events;
}

// Full per-member commission report for a month.
//   opts.scopeEmail   — restrict `members` to this one email (own-view scoping)
//   opts.includeCandidates — attach users not yet on the plan (manage picker)
export async function commissionForMonth(month, opts = {}) {
  const mk = isMonth(month) ? month : curMonthKey();
  const [cfg, memberRows, events] = await Promise.all([loadConfig(), loadMembers(), loadRecognitionEvents()]);

  let members = memberRows;
  if (opts.scopeEmail) members = memberRows.filter((m) => lc(m.email) === lc(opts.scopeEmail));

  // Events recognised this month, grouped by owner.
  const byOwner = new Map();
  for (const e of events) {
    if (e.month !== mk) continue;
    const email = lc(e.ownerEmail);
    if (!byOwner.has(email)) byOwner.set(email, { net: 0, items: [] });
    const b = byOwner.get(email);
    b.net += e.amount;
    b.items.push(e);
  }

  const out = members.map((m) => {
    const active = accruesIn(m, mk);
    const b = byOwner.get(lc(m.email));
    const net = active && b ? b.net : 0;
    const commission = computeCommission(net, cfg);
    const sales = active && b
      ? b.items
          .map((e) => ({ dealId: e.dealId, company: e.company, title: e.title, net: e.amount, date: e.date, kind: e.kind }))
          .sort((a, z) => (a.date < z.date ? 1 : -1))
      : [];
    return {
      email: m.email,
      name: m.name || m.email,
      enabled: m.enabled !== false,
      effectiveFrom: m.effective_from,
      active,
      qualifyingNet: round2(net),
      commission,
      sales,
    };
  });

  const total = round2(out.reduce((s, m) => s + (m.active ? m.commission.total : 0), 0));

  const result = {
    month: mk,
    config: { ...cfg, maxBandA: round2(cfg.bandACap * cfg.bandARate) },
    members: out,
    total,
  };

  if (opts.includeCandidates) {
    const onPlan = new Set(memberRows.map((m) => lc(m.email)));
    const users = await sql`SELECT email, name FROM users ORDER BY name NULLS LAST, email`;
    result.candidates = users
      .filter((u) => !onPlan.has(lc(u.email)))
      .map((u) => ({ email: u.email, name: u.name || u.email }));
  }
  return result;
}

// Total commission (across ALL enabled members) for each of the given months —
// used by the Cash Flow report. One recognition pass, then per-month band math.
// Returns { 'YYYY-MM': total }.
export async function commissionTotalsForMonths(monthKeys) {
  const keys = (monthKeys || []).filter(isMonth);
  const zero = Object.fromEntries(keys.map((k) => [k, 0]));
  if (!keys.length) return zero;
  const [cfg, memberRows] = await Promise.all([loadConfig(), loadMembers()]);
  const active = memberRows.filter((m) => m.enabled !== false);
  if (!active.length) return zero;

  const wanted = new Set(keys);
  const events = await loadRecognitionEvents();
  const netBy = new Map(); // `${ownerEmail}|${monthKey}` -> net recognised
  for (const e of events) {
    if (!wanted.has(e.month)) continue;
    const key = `${lc(e.ownerEmail)}|${e.month}`;
    netBy.set(key, (netBy.get(key) || 0) + e.amount);
  }

  const totals = { ...zero };
  for (const mk of keys) {
    let t = 0;
    for (const m of active) {
      if (String(m.effective_from) > mk) continue; // not yet enrolled
      const net = netBy.get(`${lc(m.email)}|${mk}`) || 0;
      t += computeCommission(net, cfg).total;
    }
    totals[mk] = round2(t);
  }
  return totals;
}

// ── HTTP route ── /api/crm/commission/...
//   GET    /                       → current-month report (scoped by permission)
//   GET    /YYYY-MM                 → that month's report
//   PATCH  /config                 → edit bands (manage)
//   GET    /members                → list members (manage)
//   POST   /members {email}        → enrol a member (manage)
//   PATCH  /members/<email>        → { enabled?, effectiveFrom? } (manage)
//   DELETE /members/<email>        → remove from plan (manage)
export async function commissionRoute(req, res, id, action, user) {
  res.setHeader('Cache-Control', 'no-store');
  await ensureCommission();

  const role = await getRole(user.role);
  const canManage = hasPermission(role, 'commission.manage');
  const canOwn = canManage || hasPermission(role, 'commission.view_own');

  // ── Band config ──
  if (id === 'config') {
    if (!canManage) return res.status(403).json({ error: 'Forbidden' });
    if (req.method === 'GET') return res.status(200).json(await loadConfig());
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const b = req.body || {};
      const cur = await loadConfig();
      const rateA = clampRate(b.bandARate, cur.bandARate);
      const rateB = clampRate(b.bandBRate, cur.bandBRate);
      const cap = b.bandACap == null ? cur.bandACap : Math.max(0, Number(b.bandACap) || 0);
      await sql`
        UPDATE commission_config
           SET band_a_rate = ${rateA}, band_a_cap = ${cap}, band_b_rate = ${rateB},
               updated_at = NOW(), updated_by = ${(user.email || '').toLowerCase() || null}
         WHERE id = 1`;
      return res.status(200).json(await loadConfig());
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Members ──
  if (id === 'members') {
    if (!canManage) return res.status(403).json({ error: 'Forbidden' });
    if (req.method === 'GET') return res.status(200).json({ members: (await loadMembers()).map(serialiseMember) });

    if (req.method === 'POST') {
      const email = String((req.body || {}).email || '').toLowerCase().trim();
      if (!email) return res.status(400).json({ error: 'email required' });
      const [u] = await sql`SELECT email FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
      if (!u) return res.status(404).json({ error: 'No such user' });
      const from = isMonth((req.body || {}).effectiveFrom) ? req.body.effectiveFrom : curMonthKey();
      await sql`
        INSERT INTO commission_members (email, enabled, effective_from)
        VALUES (${u.email}, TRUE, ${from})
        ON CONFLICT (email) DO UPDATE SET enabled = TRUE, updated_at = NOW()`;
      return res.status(201).json({ ok: true });
    }

    const email = String(action || (req.body || {}).email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'email required' });

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const b = req.body || {};
      const [cur] = await sql`SELECT email, enabled, effective_from FROM commission_members WHERE LOWER(email) = ${email}`;
      if (!cur) return res.status(404).json({ error: 'Not on the plan' });
      const enabled = 'enabled' in b ? !!b.enabled : cur.enabled;
      const from = isMonth(b.effectiveFrom) ? b.effectiveFrom : cur.effective_from;
      await sql`
        UPDATE commission_members
           SET enabled = ${enabled}, effective_from = ${from}, updated_at = NOW()
         WHERE LOWER(email) = ${email}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM commission_members WHERE LOWER(email) = ${email}`;
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Month report (default) ──
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!canOwn) return res.status(403).json({ error: 'You do not have access to commission' });
  const month = isMonth(id) ? id : curMonthKey();
  const report = await commissionForMonth(month, {
    scopeEmail: canManage ? null : (user.email || '').toLowerCase(),
    includeCandidates: canManage,
  });
  report.canManage = canManage;
  return res.status(200).json(report);
}

function serialiseMember(m) {
  return { email: m.email, name: m.name || m.email, enabled: m.enabled !== false, effectiveFrom: m.effective_from };
}

// Coerce a rate to a 0–1 fraction, falling back to the current value. Accepts a
// fraction (0.05) as-is; anything ≥ 1 is treated as a percent (5 → 0.05).
function clampRate(v, fallback) {
  if (v == null || v === '') return fallback;
  let n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n > 1) n = n / 100;
  return Math.min(1, n);
}
