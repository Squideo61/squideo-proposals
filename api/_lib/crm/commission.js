// Staff Commission — automatic sales commission for on-plan staff.
//
// Commission is calculated from real cash RECEIVED (cash basis, ex-VAT), per
// member, per month, resetting to £0 at the start of each month. Cash is
// attributed to a salesperson via the deal owner (deals.owner_email) on each
// paid row — see fetchPaidRows in stats.js, which now carries ownerEmail/dealId.
// Extras added to a sale flow through here automatically: 'final' extras ride
// the deal's final invoice/proposal payment; 'invoice_now' / 'po' extras become
// manual_invoices carrying deal_id — both are attributed to the deal owner.
//
// Two admin-editable bands (commission_config):
//   Band A: band_a_rate on net sales up to band_a_cap  (default 5% up to £5,000 → max £250)
//   Band B: band_b_rate on everything above the cap     (default 2%, uncapped)

import sql from '../db.js';
import { fetchPaidRows } from './stats.js';
import { EXCLUDED_IMPORT_DEAL_IDS } from './signedSale.js';
import { getRole } from '../userRoles.js';
import { hasPermission } from '../permissions.js';

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const monthKey = (d) => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
const curMonthKey = () => monthKey(new Date());
const isMonth = (s) => /^\d{4}-\d{2}$/.test(s || '');

// UTC [since, until) ISO bounds for a 'YYYY-MM' month.
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  return {
    since: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    until: new Date(Date.UTC(y, m, 1)).toISOString(),
  };
}

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

// Paid cash for a month, grouped by deal-owner email. Returns
// Map(email -> { net, payments: [{ dealId, net, paidAt }] }). Rows with no owner
// (proposal-less sources) and historical imported deals are excluded.
async function paidByOwnerForMonth(month) {
  const { since, until } = monthBounds(month);
  const rows = await fetchPaidRows(since, until);
  const byOwner = new Map();
  for (const r of rows) {
    const email = (r.ownerEmail || '').toLowerCase();
    if (!email) continue;
    if (r.dealId && EXCLUDED_IMPORT_DEAL_IDS.has(r.dealId)) continue;
    const net = Number(r.net) || 0;
    if (!byOwner.has(email)) byOwner.set(email, { net: 0, payments: [] });
    const b = byOwner.get(email);
    b.net += net;
    b.payments.push({ dealId: r.dealId || null, net: round2(net), paidAt: r.paidAt });
  }
  return byOwner;
}

// Deal id -> { company, title } for a set of deal ids (for the "which sales
// qualified" list). Empty set → empty map.
async function dealLabels(dealIds) {
  const ids = [...new Set(dealIds.filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = await sql`
    SELECT d.id, d.title, c.name AS company
      FROM deals d LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.id = ANY(${ids})`;
  for (const r of rows) map.set(r.id, { title: r.title || null, company: r.company || null });
  return map;
}

// A member accrues in `month` when enabled and their effective_from is that
// month or earlier (string compare works on 'YYYY-MM').
const accruesIn = (m, month) => m.enabled !== false && String(m.effective_from) <= month;

// Full per-member commission report for a month.
//   opts.scopeEmail   — restrict `members` to this one email (own-view scoping)
//   opts.includeCandidates — attach users not yet on the plan (manage picker)
export async function commissionForMonth(month, opts = {}) {
  const mk = isMonth(month) ? month : curMonthKey();
  const [cfg, memberRows, byOwner] = await Promise.all([loadConfig(), loadMembers(), paidByOwnerForMonth(month)]);

  let members = memberRows;
  if (opts.scopeEmail) {
    const email = opts.scopeEmail.toLowerCase();
    members = memberRows.filter((m) => (m.email || '').toLowerCase() === email);
  }

  // Gather deal labels for every payment we'll show.
  const dealIds = [];
  for (const m of members) {
    const b = byOwner.get((m.email || '').toLowerCase());
    if (b) for (const p of b.payments) if (p.dealId) dealIds.push(p.dealId);
  }
  const labels = await dealLabels(dealIds);

  const out = members.map((m) => {
    const active = accruesIn(m, mk);
    const b = byOwner.get((m.email || '').toLowerCase());
    const net = active && b ? b.net : 0;
    const commission = computeCommission(net, cfg);
    const sales = active && b
      ? b.payments
          .map((p) => ({ dealId: p.dealId, net: p.net, paidAt: p.paidAt, ...(labels.get(p.dealId) || { title: null, company: null }) }))
          .sort((a, z) => (a.paidAt < z.paidAt ? 1 : -1))
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
    const onPlan = new Set(memberRows.map((m) => (m.email || '').toLowerCase()));
    const users = await sql`SELECT email, name FROM users ORDER BY name NULLS LAST, email`;
    result.candidates = users
      .filter((u) => !onPlan.has((u.email || '').toLowerCase()))
      .map((u) => ({ email: u.email, name: u.name || u.email }));
  }
  return result;
}

// Total commission (across ALL enabled members) for each of the given months —
// used by the Cash Flow report. One windowed fetchPaidRows for the whole range,
// then per-month band math. Returns { 'YYYY-MM': total }.
export async function commissionTotalsForMonths(monthKeys) {
  const keys = (monthKeys || []).filter(isMonth);
  const zero = Object.fromEntries(keys.map((k) => [k, 0]));
  if (!keys.length) return zero;
  const [cfg, memberRows] = await Promise.all([loadConfig(), loadMembers()]);
  const active = memberRows.filter((m) => m.enabled !== false);
  if (!active.length) return zero;

  const sorted = [...keys].sort();
  const { since } = monthBounds(sorted[0]);
  const { until } = monthBounds(sorted[sorted.length - 1]);
  const rows = await fetchPaidRows(since, until);

  // net by `${ownerEmail}|${monthKey}`
  const netBy = new Map();
  for (const r of rows) {
    const email = (r.ownerEmail || '').toLowerCase();
    if (!email) continue;
    if (r.dealId && EXCLUDED_IMPORT_DEAL_IDS.has(r.dealId)) continue;
    const mk = monthKey(r.paidAt);
    const key = `${email}|${mk}`;
    netBy.set(key, (netBy.get(key) || 0) + (Number(r.net) || 0));
  }

  const totals = { ...zero };
  for (const mk of keys) {
    let t = 0;
    for (const m of active) {
      if (String(m.effective_from) > mk) continue; // not yet enrolled
      const net = netBy.get(`${(m.email || '').toLowerCase()}|${mk}`) || 0;
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
