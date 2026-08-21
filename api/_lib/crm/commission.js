// Staff Commission — automatic sales commission for on-plan staff.
//
// Recognition is EVENT-based (ex-VAT), per member, per month, resetting to £0
// each month. Commission on a deal's full proposal balance is granted in full
// when the FIRST PAYMENT lands, attributed to the deal owner (deals.owner_email)
// — the deposit on a 50/50, the lot on a full-up-front deal, the invoice being
// marked paid on PO work. Nothing is commissioned on a signature: signed work
// can still fall over, and commission paid on it would have to be clawed back.
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
import { demoScope } from './demoScope.js';
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
    // Sales taken off the plan by hand. Keyed on the SALE (deal + what triggered
    // it), not on a month, so the decision follows the sale if it re-dates. The
    // reason is required — a disqualification someone can't explain later is
    // worse than none.
    await sql`
      CREATE TABLE IF NOT EXISTS commission_disqualifications (
        event_key       TEXT PRIMARY KEY,
        deal_id         TEXT,
        owner_email     TEXT,
        reason          TEXT NOT NULL,
        disqualified_by TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

// What each individual sale earned. The bands are cumulative across the month,
// so a sale's rate depends on how much had already been counted before it: the
// earliest sale fills Band A first, and a sale that straddles the cap earns 5%
// on the part inside and 2% on the part above. Items are therefore walked in
// recognition order (oldest first) whatever order they're displayed in.
//
// Rounding is done on the RUNNING total and taken as a difference, so the per-
// sale figures always add up to the month's Band A / Band B / total exactly —
// rounding each sale on its own could leave the rows a penny off the header.
//
// `startCounted` seeds the ladder with net already counted before these items —
// used by the pending forecast, which prices what's still owed at the MARGINAL
// rate it would earn if it landed on top of the month as it stands today.
export function commissionPerSale(items, cfg, startCounted = 0) {
  const cap = Math.max(0, Number(cfg.bandACap) || 0);
  const rateA = Number(cfg.bandARate) || 0;
  const rateB = Number(cfg.bandBRate) || 0;
  let counted = Math.max(0, Number(startCounted) || 0); // net recognised so far this month
  // The commission already earned on `counted`, so the first row below is priced
  // at the rate the NEXT pound earns rather than restarting at Band A.
  let exactA = Math.min(counted, cap) * rateA;
  let exactB = Math.max(0, counted - cap) * rateB;
  let paidA = round2(exactA), paidB = round2(exactB);
  return items
    .slice()
    .sort((a, z) => (a.date < z.date ? -1 : a.date > z.date ? 1 : 0))
    .map((e) => {
      const net = Math.max(0, Number(e.amount) || 0);
      const inA = Math.max(0, Math.min(net, cap - counted));
      const inB = net - inA;
      counted += net;
      exactA += inA * rateA;
      exactB += inB * rateB;
      const bandA = round2(round2(exactA) - paidA);
      const bandB = round2(round2(exactB) - paidB);
      paidA = round2(exactA);
      paidB = round2(exactB);
      const commission = round2(bandA + bandB);
      return {
        // The sale's stable identity — what a disqualification is keyed on.
        key: e.key,
        dealId: e.dealId,
        company: e.company,
        title: e.title,
        net: round2(net),
        date: e.date,
        kind: e.kind,
        bandA,
        bandB,
        commission,
        // The rate actually earned on this sale — the band rate when it sits
        // wholly in one band, a blend when it straddles the cap.
        rate: net > 0 ? commission / net : 0,
      };
    });
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
//     trigger), recognised in full when the FIRST PAYMENT lands. That's the
//     deposit on a 50/50, the whole thing on a full-up-front deal, and the
//     invoice being marked paid on PO work — money in, whatever the route.
//   • EXTRA — each PAID extra ADDED AFTER the trigger, recognised in the month
//     its cash landed (deal_extras.paid_at). Extras that existed at/before the
//     trigger are folded into BASE, so they're never counted twice.
// A deal with NO signed proposal has no proposal balance, so its BASE is zero —
// but work recorded against it ("Record sale") still counts, and it's the whole
// sale rather than an addition to one. Recognition still follows the cash.
//
// Returns { events, pending }:
//   events  — [{ ownerEmail, dealId, company, title, month, amount, kind, date }]
//             money already in, i.e. commission EARNED.
//   pending — the same sales seen from the other side: signed work whose money
//             hasn't landed yet (PO work waiting on its invoice, a deposit not
//             yet paid) and unpaid extras. Nothing here is earned — it's what
//             WILL be recognised, in the month the payment lands. See
//             `pendingCommissionFor`.
// What the base event is called. A deal with no signed proposal has no deposit
// to speak of — its base is entirely recorded sales, so calling it a "deposit"
// on the commission screen would read as a bug.
const commissionKind = (d) => (d.isPo ? 'po_paid' : (d.net > 0 ? 'deposit' : 'sale'));

async function loadRecognitionEvents() {
  const [sigRows, payRows, extraRows, invoicedRows] = await Promise.all([
    // Signed proposals (base candidates). data columns are JSONB → parsed objects.
    sql`SELECT d.id AS deal_id, d.owner_email, d.title, d.stage, c.name AS company, d.company_id,
               s.signed_at, s.data AS sig_data, p.data AS prop_data
          FROM signatures s
          JOIN proposals p ON p.id = s.proposal_id
          JOIN deals d ON d.id = p.deal_id
          LEFT JOIN companies c ON c.id = d.company_id`,
    // Earliest payment per deal — the trigger for every base event. Every way
    // money can be recorded against a deal has to be in here: a deal that was
    // paid through its INVOICE (the usual route for PO work and anything billed
    // up front) would otherwise never trigger, and the sale would silently never
    // be commissioned.
    sql`SELECT deal_id, MIN(paid_at) AS first_paid
          FROM (
            SELECT p.deal_id, x.paid_at
              FROM (
                SELECT proposal_id, paid_at FROM payments WHERE paid_at IS NOT NULL
                UNION ALL SELECT proposal_id, paid_at FROM manual_payments_counted WHERE manual_invoice_id IS NULL AND paid_at IS NOT NULL
                UNION ALL SELECT proposal_id, paid_at FROM proposal_billing WHERE paid_at IS NOT NULL
                UNION ALL SELECT proposal_id, paid_at FROM partner_invoices WHERE paid_at IS NOT NULL
              ) x
              JOIN proposals p ON p.id = x.proposal_id
            UNION ALL
            -- An invoice marked paid is money in. It may be linked to the deal
            -- directly or only through its proposal, so take whichever it has.
            -- Invoices flagged out of the stats don't count.
            SELECT COALESCE(mi.deal_id, pr.deal_id) AS deal_id, mi.paid_at
              FROM manual_invoices mi
              LEFT JOIN proposals pr ON pr.id = mi.proposal_id
             WHERE mi.status = 'paid' AND mi.paid_at IS NOT NULL
               AND COALESCE(mi.exclude_from_stats, false) = false
          ) y
         WHERE deal_id IS NOT NULL
         GROUP BY deal_id`,
    // Extras (net amounts), with the durable paid date (falls back to updated_at).
    sql`SELECT e.id AS extra_id, e.deal_id, e.amount, e.status, e.created_at,
               COALESCE(e.paid_at, e.updated_at) AS paid_at,
               d.owner_email, d.title, c.name AS company, d.company_id, d.stage
          FROM deal_extras e
          JOIN deals d ON d.id = e.deal_id
          LEFT JOIN companies c ON c.id = d.company_id`,
    // Has an invoice actually gone out on this deal and not been paid? Only used
    // to annotate the pending list ("invoiced 12 Jul" vs "not invoiced yet") —
    // never to decide whether something is pending, so a missing table is fine.
    sql`SELECT COALESCE(mi.deal_id, pr.deal_id) AS deal_id,
               MIN(COALESCE(mi.issued_at, mi.created_at)) AS invoiced_at
          FROM manual_invoices mi
          LEFT JOIN proposals pr ON pr.id = mi.proposal_id
         WHERE mi.status = 'issued'
         GROUP BY COALESCE(mi.deal_id, pr.deal_id)`.catch(() => []),
  ]);

  // The seeded demo project is a signed £2,400 deal you're meant to pay during
  // testing — it must never earn anyone commission.
  const { isDemo } = await demoScope();

  const firstPaid = new Map();
  for (const r of payRows) if (r.first_paid) firstPaid.set(r.deal_id, new Date(r.first_paid));

  // Aggregate signed proposals per deal (a deal can carry more than one).
  const deals = new Map();
  for (const r of sigRows) {
    if (EXCLUDED_IMPORT_DEAL_IDS.has(r.deal_id) || isDemo(r)) continue;
    let d = deals.get(r.deal_id);
    if (!d) { d = { ownerEmail: r.owner_email, title: r.title, company: r.company, stage: r.stage, isPo: false, signedAt: null, net: 0 }; deals.set(r.deal_id, d); }
    d.net += Number(computeProposalTotalExVat(r.prop_data, r.sig_data)) || 0;
    if (r.sig_data && r.sig_data.paymentOption === 'po') d.isPo = true;
    const signedAt = r.signed_at ? new Date(r.signed_at) : null;
    if (signedAt && (!d.signedAt || signedAt < d.signedAt)) d.signedAt = signedAt;
  }

  const extrasByDeal = new Map();
  for (const r of extraRows) {
    if (EXCLUDED_IMPORT_DEAL_IDS.has(r.deal_id) || isDemo(r)) continue;
    // Work sold on a deal that has no proposal ("Record sale") — the deal isn't
    // in `deals` above, which is built from signatures, so the loop below would
    // never visit it and the sale would earn nobody anything. Register it with
    // no signed base: its whole value is the recorded lines.
    if (!deals.has(r.deal_id) && r.owner_email) {
      deals.set(r.deal_id, {
        ownerEmail: r.owner_email, title: r.title, company: r.company,
        stage: r.stage, isPo: false, signedAt: null, net: 0,
      });
    }
    if (!extrasByDeal.has(r.deal_id)) extrasByDeal.set(r.deal_id, []);
    extrasByDeal.get(r.deal_id).push({
      id: r.extra_id,
      amount: Number(r.amount) || 0, status: r.status,
      createdAt: r.created_at ? new Date(r.created_at) : null,
      paidAt: r.paid_at ? new Date(r.paid_at) : null,
    });
  }

  const invoicedAt = new Map();
  for (const r of invoicedRows) if (r.deal_id && r.invoiced_at) invoicedAt.set(r.deal_id, new Date(r.invoiced_at).toISOString());

  const events = [];
  const pending = [];
  for (const [dealId, d] of deals) {
    if (!d.ownerEmail) continue;
    // Trigger: the first payment, for every deal. Nothing is commissioned on a
    // signature alone — PO work included: a PO can be signed and then not go
    // ahead, and paying commission on it would mean clawing it back. No payment
    // yet → no base event, though a paid extra can still recognise on its own.
    const triggerDate = firstPaid.get(dealId) || null;
    const dealExtras = extrasByDeal.get(dealId) || [];

    if (triggerDate) {
      let base = d.net;
      for (const x of dealExtras) if (x.createdAt && x.createdAt <= triggerDate) base += x.amount;
      base = round2(base);
      if (base > 0) {
        const kind = commissionKind(d);
        events.push({ ownerEmail: d.ownerEmail, dealId, company: d.company, title: d.title,
          month: monthKey(triggerDate), amount: base, kind, date: triggerDate.toISOString(),
          key: `${dealId}:${kind}` });
      }
    } else if (d.stage !== 'lost') {
      // Signed, nothing paid yet — the whole balance is COMING, not earned. Same
      // amount and same key the base event will carry when the money lands, so a
      // sale keeps its identity (and any disqualification) across the line.
      // Extras already recognised on their own (paid ones) are left out: they'd
      // otherwise be forecast and earned at the same time.
      let base = d.net;
      for (const x of dealExtras) if (x.status !== 'paid') base += x.amount;
      base = round2(base);
      if (base > 0) {
        const kind = commissionKind(d);
        pending.push({ ownerEmail: d.ownerEmail, dealId, company: d.company, title: d.title,
          amount: base, kind, date: (d.signedAt || new Date()).toISOString(),
          invoicedAt: invoicedAt.get(dealId) || null, key: `${dealId}:${kind}` });
      }
    }

    for (const x of dealExtras) {
      if (x.status !== 'paid' || !x.paidAt || x.amount <= 0) continue;
      if (triggerDate && x.createdAt && x.createdAt <= triggerDate) continue; // folded into BASE
      events.push({ ownerEmail: d.ownerEmail, dealId, company: d.company, title: d.title,
        month: monthKey(x.paidAt), amount: round2(x.amount), kind: 'extra', date: x.paidAt.toISOString(),
        key: `${dealId}:extra:${x.id}` });
    }

    // Unpaid extras added AFTER the deal triggered — each is commissioned on its
    // own when its cash lands, so each is pending on its own. Quoted extras are
    // only a quote, so they're left out (same rule as Finance's Pending
    // Payments); an extra on a not-yet-triggered deal is already inside its
    // pending base above.
    if (triggerDate) {
      for (const x of dealExtras) {
        if (x.status === 'paid' || x.status === 'quoted' || x.amount <= 0) continue;
        if (x.createdAt && x.createdAt <= triggerDate) continue; // inside the base already
        pending.push({ ownerEmail: d.ownerEmail, dealId, company: d.company, title: d.title,
          amount: round2(x.amount), kind: 'extra',
          date: (x.createdAt || new Date()).toISOString(),
          invoicedAt: x.status === 'invoiced' ? (invoicedAt.get(dealId) || null) : null,
          key: `${dealId}:extra:${x.id}` });
      }
    }
  }
  return { events, pending };
}

// ── Disqualifications ──
// event_key → { reason, by, at }. Keyed on the sale, so it holds even if the
// sale re-dates into another month.
async function loadDisqualifications() {
  await ensureCommission();
  const rows = await sql`
    SELECT event_key, reason, disqualified_by, created_at FROM commission_disqualifications
  `.catch(() => []);
  return new Map(rows.map((r) => [r.event_key, {
    reason: r.reason,
    by: r.disqualified_by || null,
    at: r.created_at,
  }]));
}

// What a member is owed but hasn't earned yet, priced at the rate it WOULD earn
// if it landed today — i.e. stacked on top of what the current month has already
// counted, oldest first. It's a forecast, not a promise: the actual figure
// depends on the month the money lands in and what else lands with it, which is
// why the UI says so plainly.
//
// Deliberately keyed off the CURRENT month, not the month being viewed — money
// that hasn't arrived can't be recognised in a month that's already been and
// gone, so looking back at June must not re-price June's pending as if it were.
//
// A cancelled sale earns nothing and takes no part in the banding, but stays on
// the list with its reason: it's money someone was expecting, and it vanishing
// silently is exactly the version of this that causes an argument later. The
// decision is keyed on the sale, so it still holds when the payment lands.
function pendingCommissionFor(bucket, currentMonthNet, cfg) {
  const items = bucket?.items || [];
  const cancelled = bucket?.cancelled || [];
  // Keyed rather than positional: commissionPerSale re-sorts, so lining the
  // annotations up by index would quietly attach the wrong invoice date.
  const invoiced = new Map(items.map((p) => [p.key, p.invoicedAt || null]));
  const priced = commissionPerSale(items, cfg, currentMonthNet).map((s) => ({
    ...s,
    invoicedAt: invoiced.get(s.key) || null,
  }));
  const net = round2(priced.reduce((s, p) => s + p.net, 0));
  const bandA = round2(priced.reduce((s, p) => s + p.bandA, 0));
  const bandB = round2(priced.reduce((s, p) => s + p.bandB, 0));
  const off = cancelled.map((p) => ({
    key: p.key, dealId: p.dealId, company: p.company, title: p.title,
    net: round2(p.amount), date: p.date, kind: p.kind, invoicedAt: p.invoicedAt || null,
    bandA: 0, bandB: 0, commission: 0, rate: 0, disqualified: p.disqualified,
  }));
  return {
    net,
    commission: { bandA, bandB, total: round2(bandA + bandB) },
    cancelledNet: round2(off.reduce((s, p) => s + p.net, 0)),
    // Newest first, matching the earned table above it.
    items: [...priced, ...off].sort((a, z) => (a.date < z.date ? 1 : -1)),
  };
}

// Full per-member commission report for a month.
//   opts.scopeEmail   — restrict `members` to this one email (own-view scoping)
//   opts.includeCandidates — attach users not yet on the plan (manage picker)
export async function commissionForMonth(month, opts = {}) {
  const mk = isMonth(month) ? month : curMonthKey();
  const [cfg, memberRows, recognition, disqualified] = await Promise.all([
    loadConfig(), loadMembers(), loadRecognitionEvents(), loadDisqualifications(),
  ]);
  const { events, pending: pendingEvents } = recognition;

  let members = memberRows;
  if (opts.scopeEmail) members = memberRows.filter((m) => lc(m.email) === lc(opts.scopeEmail));

  // Events recognised this month, grouped by owner. A disqualified sale is kept
  // out of the qualifying net but still listed — the sheet has to show what was
  // taken off and why, or the decision disappears the moment it's made.
  const byOwner = new Map();
  for (const e of events) {
    if (e.month !== mk) continue;
    const email = lc(e.ownerEmail);
    if (!byOwner.has(email)) byOwner.set(email, { net: 0, items: [], excluded: [] });
    const b = byOwner.get(email);
    const dq = disqualified.get(e.key);
    if (dq) { b.excluded.push({ ...e, disqualified: dq }); continue; }
    b.net += e.amount;
    b.items.push(e);
  }

  // Pending is always priced against the CURRENT month's ladder, whichever month
  // is on screen — so the same £ figure is quoted in July as in August.
  const nowKey = curMonthKey();
  const currentNet = new Map();
  for (const e of events) {
    if (e.month !== nowKey || disqualified.has(e.key)) continue;
    const email = lc(e.ownerEmail);
    currentNet.set(email, (currentNet.get(email) || 0) + e.amount);
  }
  const pendingByOwner = new Map();
  for (const p of pendingEvents) {
    const email = lc(p.ownerEmail);
    if (!pendingByOwner.has(email)) pendingByOwner.set(email, { items: [], cancelled: [] });
    const dq = disqualified.get(p.key);
    if (dq) pendingByOwner.get(email).cancelled.push({ ...p, disqualified: dq });
    else pendingByOwner.get(email).items.push(p);
  }

  const out = members.map((m) => {
    const active = accruesIn(m, mk);
    const b = byOwner.get(lc(m.email));
    const net = active && b ? b.net : 0;
    const commission = computeCommission(net, cfg);
    // Banded oldest-first (that's the order the cap fills in), shown newest-first.
    const earning = active && b ? commissionPerSale(b.items, cfg) : [];
    // Disqualified sales earn nothing and take no part in the banding, so they're
    // simply folded back into the list at their own date.
    const excluded = active && b
      ? b.excluded.map((e) => ({
        dealId: e.dealId, company: e.company, title: e.title, net: round2(e.amount),
        date: e.date, kind: e.kind, key: e.key,
        bandA: 0, bandB: 0, commission: 0, rate: 0, disqualified: e.disqualified,
      }))
      : [];
    const sales = [...earning, ...excluded].sort((a, z) => (a.date < z.date ? 1 : -1));
    // Pending belongs to whoever is on the plan NOW (enabled + enrolled by this
    // month), not to the month being looked at — a paused member is forecast
    // nothing, and someone who joins next month sees what's coming with them.
    const onPlanNow = accruesIn(m, nowKey);
    const basisNet = round2(currentNet.get(lc(m.email)) || 0);
    const pending = onPlanNow
      ? pendingCommissionFor(pendingByOwner.get(lc(m.email)), basisNet, cfg)
      : { net: 0, commission: { bandA: 0, bandB: 0, total: 0 }, cancelledNet: 0, items: [] };
    return {
      email: m.email,
      name: m.name || m.email,
      enabled: m.enabled !== false,
      effectiveFrom: m.effective_from,
      active,
      qualifyingNet: round2(net),
      disqualifiedNet: round2(excluded.reduce((s, e) => s + e.net, 0)),
      commission,
      sales,
      // Not yet earned — see pendingCommissionFor. `basisNet`/`basisMonth` say
      // what the estimate was stacked on, so the UI can explain the rate.
      pending: { ...pending, basisNet, basisMonth: nowKey },
    };
  });

  const total = round2(out.reduce((s, m) => s + (m.active ? m.commission.total : 0), 0));
  const pendingTotal = round2(out.reduce((s, m) => s + m.pending.commission.total, 0));
  const pendingNet = round2(out.reduce((s, m) => s + m.pending.net, 0));

  const result = {
    month: mk,
    config: { ...cfg, maxBandA: round2(cfg.bandACap * cfg.bandARate) },
    members: out,
    total,
    pendingTotal,
    pendingNet,
    pendingMonth: nowKey,
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
  const [{ events }, disqualified] = await Promise.all([loadRecognitionEvents(), loadDisqualifications()]);
  const netBy = new Map(); // `${ownerEmail}|${monthKey}` -> net recognised
  for (const e of events) {
    if (!wanted.has(e.month)) continue;
    if (disqualified.has(e.key)) continue; // taken off the plan by hand
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

// Per-member commission for a single month, for the Cash Flow display (one cost
// line each). Returns [{ email, name, total }] for every member accruing that
// month (enabled + enrolled), including £0 so the plan members always show.
export async function commissionByMemberForMonth(month) {
  const mk = isMonth(month) ? month : curMonthKey();
  const [cfg, memberRows, { events }, disqualified] = await Promise.all([
    loadConfig(), loadMembers(), loadRecognitionEvents(), loadDisqualifications(),
  ]);
  const netBy = new Map();
  for (const e of events) {
    if (e.month !== mk || disqualified.has(e.key)) continue;
    netBy.set(lc(e.ownerEmail), (netBy.get(lc(e.ownerEmail)) || 0) + e.amount);
  }
  const out = [];
  for (const m of memberRows) {
    if (!accruesIn(m, mk)) continue;
    const net = netBy.get(lc(m.email)) || 0;
    out.push({ email: m.email, name: m.name || m.email, total: computeCommission(net, cfg).total });
  }
  return out;
}

// ── HTTP route ── /api/crm/commission/...
//   GET    /                       → current-month report (scoped by permission)
//   GET    /YYYY-MM                 → that month's report
//   PATCH  /config                 → edit bands (manage)
//   GET    /members                → list members (manage)
//   POST   /members {email}        → enrol a member (manage)
//   PATCH  /members/<email>        → { enabled?, effectiveFrom? } (manage)
//   DELETE /members/<email>        → remove from plan (manage)
//   POST   /disqualify {key, reason} → take a sale off the plan (manage)
//   DELETE /disqualify/<key>       → put it back (manage)
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

  // ── Disqualifying a sale ──
  // Directors and admins only (commission.manage). A reason is required and is
  // kept with the decision — this is money someone was expecting.
  if (id === 'disqualify') {
    if (!canManage) return res.status(403).json({ error: 'Forbidden' });

    if (req.method === 'POST') {
      const b = req.body || {};
      const key = String(b.key || '').trim();
      const reason = String(b.reason || '').trim();
      if (!key) return res.status(400).json({ error: 'key required' });
      if (!reason) return res.status(400).json({ error: 'A reason is required to disqualify a sale' });
      if (reason.length > 500) return res.status(400).json({ error: 'Keep the reason under 500 characters' });
      await sql`
        INSERT INTO commission_disqualifications (event_key, deal_id, owner_email, reason, disqualified_by)
        VALUES (${key}, ${String(b.dealId || '').trim() || null}, ${lc(b.ownerEmail) || null},
                ${reason}, ${lc(user.email) || null})
        ON CONFLICT (event_key) DO UPDATE
          SET reason = EXCLUDED.reason,
              disqualified_by = EXCLUDED.disqualified_by,
              created_at = NOW()`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const key = String(action || (req.body || {}).key || '').trim();
      if (!key) return res.status(400).json({ error: 'key required' });
      await sql`DELETE FROM commission_disqualifications WHERE event_key = ${key}`;
      return res.status(200).json({ ok: true });
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
