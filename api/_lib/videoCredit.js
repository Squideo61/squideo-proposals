// Video Credit — the client-portal "buy a block of production minutes now, draw
// it down later" feature. It deliberately reuses the existing partner-credit
// ledger (partner_subscriptions + credit_allocations, measured in MINUTES of
// finished video) so a portal purchase shows up in the CRM's Partners & Credits
// list and the company page mirror with no parallel system.
//
// Pricing mirrors the standard one-off "Content Credit" discount tiers used on
// proposals (Base 10% · Per extra 2.5% · Max 20%): a per-minute rate discounted
// more the more minutes you buy. This is the SERVER-SIDE authority — the portal
// computes the same numbers for display, but the Stripe amount is always
// recomputed here.

import sql from './db.js';
import { creditTotalsForKeys, clientKeysForCompany } from './partnerCredits.js';
import { notifyPortalUser } from './portal/notifications.js';
import { sendNotification, ensurePortalNotificationDefaults } from './notifications.js';
import { VIDEO_CREDIT, videoCreditDiscount, videoCreditQuote } from './videoCreditPricing.js';
import { makeId } from './crm/shared.js';
import { createXeroInvoiceForDeal } from './crm/invoices.js';

// Re-export the pure pricing surface so existing importers (api/portal.js) keep
// getting videoCreditQuote/videoCreditDiscount/VIDEO_CREDIT from here.
export { VIDEO_CREDIT, videoCreditDiscount, videoCreditQuote };

// The per-minute standard rate. Honours a business-configured rate on the
// default proposal (settings.default_proposal.partnerProgramme.standardRatePerMin)
// so portal credit stays aligned with what's quoted elsewhere; falls back to the
// documented default.
export async function videoCreditRatePerMin() {
  try {
    const [row] = await sql`SELECT default_proposal FROM settings WHERE id = 1`;
    const r = Number(row?.default_proposal?.partnerProgramme?.standardRatePerMin);
    if (Number.isFinite(r) && r > 0) return r;
  } catch { /* fall back to the default below */ }
  return VIDEO_CREDIT.defaultRatePerMin;
}

// The pricing parameters the portal needs to render the live stepper. The portal
// mirrors videoCreditQuote() for display only — the purchase amount is always
// recomputed server-side.
export async function videoCreditPricingParams() {
  const ratePerMin = await videoCreditRatePerMin();
  return {
    ratePerMin,
    baseDiscount: VIDEO_CREDIT.baseDiscount,
    stepPerMin: VIDEO_CREDIT.stepPerMin,
    maxDiscount: VIDEO_CREDIT.maxDiscount,
    vatRate: VIDEO_CREDIT.vatRate,
  };
}

// A company's partner-credit client_keys. Delegates to the shared resolver so
// the portal balance and the CRM company mirror can never drift apart again —
// and so it works from an id alone (the portal's session company object has no
// xero_contact_id, which used to silently lose the Xero match).
export async function resolveCompanyCreditKeys(company) {
  return clientKeysForCompany(company?.id || company);
}

// The company's aggregate credit balance in minutes, summed across every key.
export async function companyCreditBalance(company) {
  const keys = await resolveCompanyCreditKeys(company);
  if (!keys.length) return { issued: 0, used: 0, remaining: 0, keys: [] };
  const totals = await creditTotalsForKeys(keys);
  const issued = totals.reduce((s, t) => s + (Number(t.credits_issued) || 0), 0);
  const used = totals.reduce((s, t) => s + (Number(t.credits_used) || 0), 0);
  return { issued, used, remaining: issued - used, keys };
}

// Ensure the company has a client_key its credit can attach to. If it already
// has one (real partner sub or a prior anchor) we reuse it; otherwise we create
// a "credits-only" manual subscription (0 credits/month, auto_credit off) keyed
// by the company name — the same shape the CRM uses for a client that just holds
// a balance — so the purchase is visible everywhere credit is shown.
export async function ensureCompanyCreditKey(company) {
  const companyId = company?.id || company;
  const existing = await clientKeysForCompany(companyId);
  if (existing.length) return existing[0];
  // Read the company fresh rather than trusting the caller's object — a portal
  // session's copy carries no xero_contact_id, and stamping the anchor without
  // it would leave the new key unmatchable by the Xero route later.
  const [co] = await sql`SELECT id, name, xero_contact_id FROM companies WHERE id = ${companyId}`;
  if (!co) return null;
  const key = (String(co.name || '').trim().toLowerCase()) || ('company_' + co.id);
  const subId = 'manual_portalcredit_' + co.id;
  await sql`
    INSERT INTO partner_subscriptions
      (stripe_subscription_id, proposal_id, client_key, client_name,
       credits_per_month, status, auto_credit, xero_contact_id)
    VALUES
      (${subId}, NULL, ${key}, ${co.name || key},
       0, 'active', FALSE, ${co.xero_contact_id || null})
    ON CONFLICT (stripe_subscription_id) DO NOTHING`;
  return key;
}

// Add purchased minutes to a company's ledger as a positive adjustment.
// Idempotent on sourceRef so a re-delivered Stripe webhook can't double-credit.
export async function addVideoCreditMinutes({ company, minutes, description, sourceRef, actor }) {
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  if (!m || !company?.id) return { added: 0 };
  if (sourceRef) {
    const [dupe] = await sql`SELECT 1 FROM credit_allocations WHERE source_ref = ${sourceRef} LIMIT 1`;
    if (dupe) return { added: 0, duplicate: true };
  }
  const key = await ensureCompanyCreditKey(company);
  await sql`
    INSERT INTO credit_allocations
      (client_key, proposal_id, description, credit_cost, kind, allocated_by, source_ref)
    VALUES
      (${key}, NULL, ${description || 'Video credit purchase'}, ${m}, 'adjustment', ${actor || null}, ${sourceRef || null})`;
  return { added: m, key };
}

// Apply a completed Stripe "video_credit_topup" checkout: credit the minutes and
// tell the client (and the team) it landed. Best-effort — never throws so the
// webhook can always 200.
export async function completeVideoCreditTopup(session) {
  const meta = session?.metadata || {};
  const companyId = meta.companyId || null;
  const minutes = Math.max(0, Math.floor(Number(meta.minutes) || 0));
  if (!companyId || !minutes) return;
  const [company] = await sql`SELECT id, name, xero_contact_id FROM companies WHERE id = ${companyId}`;
  if (!company) return;

  const { added, duplicate } = await addVideoCreditMinutes({
    company,
    minutes,
    description: `Video credit purchase — ${minutes} min (portal, card)`,
    sourceRef: 'portalcredit_' + session.id,
    actor: meta.portalUserEmail || null,
  });
  if (!added || duplicate) return;

  // Record a finance/audit order row for the card sale (best-effort).
  try {
    await ensureVideoCreditOrders();
    const rate = Number(meta.ratePerMin) || VIDEO_CREDIT.defaultRatePerMin;
    const q = videoCreditQuote(minutes, rate);
    await sql`
      INSERT INTO video_credit_orders
        (id, company_id, minutes, rate_per_min, subtotal_ex_vat, vat, total_inc_vat,
         status, payment_route, requested_by, credited_at, source_ref)
      SELECT ${makeId('vco')}, ${companyId}, ${minutes}, ${rate},
             ${Number(q.subtotalExVat.toFixed(2))}, ${Number(q.vat.toFixed(2))}, ${Number(q.totalIncVat.toFixed(2))},
             'paid', 'card', ${meta.portalUserEmail || null}, NOW(), ${'card_' + session.id}
       WHERE NOT EXISTS (SELECT 1 FROM video_credit_orders WHERE source_ref = ${'card_' + session.id})`;
  } catch (err) { console.warn('[videoCredit] card order record failed', err.message); }

  try {
    await notifyPortalUser({
      companyId,
      key: 'portal.video_credit_added',
      title: 'Video credit added 🎬',
      body: `${minutes} minute${minutes === 1 ? '' : 's'} of video credit is now on your balance.`,
      link: '#/video-credit',
    });
  } catch { /* best-effort */ }
  try {
    await ensurePortalNotificationDefaults();
    await sendNotification('portal.video_credit_purchase', {
      subject: `🎬 Video credit purchased — ${company.name || companyId}`,
      text: `${company.name || 'A portal client'} bought ${minutes} minute${minutes === 1 ? '' : 's'} of video credit by card. It's on their credit balance now.`,
      inApp: {
        title: 'Video credit purchased',
        body: `${company.name || ''} · ${minutes} min`,
        link: `#/company/${companyId}`,
      },
    });
  } catch { /* best-effort */ }
}

// ─── Finance-tracked credit orders ───────────────────────────────────────────
// A credit purchase's lifecycle so it appears in finance, not just as a balance
// bump: requested → invoiced (a standalone company Xero invoice raised by staff,
// which lands on Pending Payments + counts as a "cash generated" sale) → paid
// (auto-credits the minutes). Card sales are recorded straight as 'paid'/'card'.

let ordersReady = null;
export function ensureVideoCreditOrders() {
  if (ordersReady) return ordersReady;
  ordersReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS video_credit_orders (
        id               TEXT        PRIMARY KEY,
        company_id       TEXT        NOT NULL,
        minutes          INTEGER     NOT NULL,
        rate_per_min     NUMERIC     NOT NULL,
        subtotal_ex_vat  NUMERIC     NOT NULL,
        vat              NUMERIC     NOT NULL,
        total_inc_vat    NUMERIC     NOT NULL,
        status           TEXT        NOT NULL DEFAULT 'requested',
        payment_route    TEXT        NOT NULL DEFAULT 'invoice',
        manual_invoice_id TEXT,
        requested_by     TEXT,
        credited_at      TIMESTAMPTZ,
        source_ref       TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS video_credit_orders_company_idx ON video_credit_orders(company_id, created_at DESC)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS video_credit_orders_source_ref_idx ON video_credit_orders(source_ref) WHERE source_ref IS NOT NULL`;
  })().catch((err) => { ordersReady = null; throw err; });
  return ordersReady;
}

function serialiseOrder(o) {
  return {
    id: o.id,
    companyId: o.company_id,
    minutes: o.minutes,
    ratePerMin: Number(o.rate_per_min),
    subtotalExVat: Number(o.subtotal_ex_vat),
    vat: Number(o.vat),
    totalIncVat: Number(o.total_inc_vat),
    status: o.status,
    paymentRoute: o.payment_route,
    manualInvoiceId: o.manual_invoice_id || null,
    requestedBy: o.requested_by || null,
    creditedAt: o.credited_at || null,
    createdAt: o.created_at,
  };
}

// A client requested to buy credit by invoice — record it for staff to action.
export async function createVideoCreditInvoiceOrder({ company, minutes, ratePerMin, requestedBy }) {
  await ensureVideoCreditOrders();
  const q = videoCreditQuote(minutes, ratePerMin);
  const id = makeId('vco');
  const [row] = await sql`
    INSERT INTO video_credit_orders
      (id, company_id, minutes, rate_per_min, subtotal_ex_vat, vat, total_inc_vat,
       status, payment_route, requested_by)
    VALUES
      (${id}, ${company.id}, ${q.minutes}, ${q.ratePerMin},
       ${Number(q.subtotalExVat.toFixed(2))}, ${Number(q.vat.toFixed(2))}, ${Number(q.totalIncVat.toFixed(2))},
       'requested', 'invoice', ${requestedBy || null})
    RETURNING *`;
  return serialiseOrder(row);
}

// The Xero line item for a credit order (ex-VAT amount + 20% VAT added by Xero).
function creditLineItems(o) {
  const gross = Number(o.rate_per_min) * Number(o.minutes);
  const pct = gross > 0 ? Math.round((1 - Number(o.subtotal_ex_vat) / gross) * 100) : 0;
  return [{
    description: `Video credit — ${o.minutes} minute${o.minutes === 1 ? '' : 's'} of production time${pct > 0 ? ` (${pct}% bulk discount)` : ''}`,
    quantity: 1,
    unitAmount: Number(o.subtotal_ex_vat),
    vatRate: 20,
  }];
}

// Staff action: raise the standalone company Xero invoice for a requested order.
// It then shows on Pending Payments and counts as a sale; the minutes are added
// when the invoice is marked paid (see reconcileVideoCreditOrders).
export async function raiseInvoiceForCreditOrder(orderId, user) {
  await ensureVideoCreditOrders();
  const [o] = await sql`SELECT * FROM video_credit_orders WHERE id = ${orderId}`;
  if (!o) { const e = new Error('Credit request not found'); e.status = 404; throw e; }
  if (o.status !== 'requested') { const e = new Error('This credit request has already been actioned.'); e.status = 409; throw e; }
  const inv = await createXeroInvoiceForDeal({ companyId: o.company_id, lineItems: creditLineItems(o) }, user);
  const manualId = String(inv.id).replace(/^manual:/, '');
  await sql`
    UPDATE video_credit_orders
       SET status = 'invoiced', manual_invoice_id = ${manualId}, updated_at = NOW()
     WHERE id = ${orderId}`;
  return { order: serialiseOrder({ ...o, status: 'invoiced', manual_invoice_id: manualId }), invoice: inv };
}

// Cancel a still-pending (unraised) credit request.
export async function cancelCreditOrder(orderId) {
  await ensureVideoCreditOrders();
  const [row] = await sql`
    UPDATE video_credit_orders SET status = 'cancelled', updated_at = NOW()
     WHERE id = ${orderId} AND status = 'requested' RETURNING id`;
  if (!row) { const e = new Error('This request can no longer be cancelled.'); e.status = 409; throw e; }
  return { ok: true };
}

// Lazy reconcile: any 'invoiced' order whose linked manual invoice is now paid
// gets its minutes credited (idempotent) and moves to 'paid'. Called on read
// from the portal balance + the company credits view so the balance updates
// without hooking every payment site. Returns the number credited.
export async function reconcileVideoCreditOrders(companyIds = null) {
  await ensureVideoCreditOrders().catch(() => {});
  const ids = companyIds && companyIds.length ? companyIds : null;
  let rows;
  try {
    rows = await sql`
      SELECT o.* FROM video_credit_orders o
      JOIN manual_invoices mi ON mi.id = o.manual_invoice_id
      WHERE o.status = 'invoiced' AND mi.status = 'paid'
        AND (${ids}::text[] IS NULL OR o.company_id = ANY(${ids}::text[]))`;
  } catch { return 0; }
  let credited = 0;
  for (const o of rows) {
    const [company] = await sql`SELECT id, name, xero_contact_id FROM companies WHERE id = ${o.company_id}`;
    if (!company) continue;
    await addVideoCreditMinutes({
      company,
      minutes: o.minutes,
      description: `Video credit — ${o.minutes} min (invoice paid)`,
      sourceRef: 'vco_' + o.id,
      actor: null,
    });
    const [upd] = await sql`
      UPDATE video_credit_orders SET status = 'paid', credited_at = NOW(), updated_at = NOW()
       WHERE id = ${o.id} AND status = 'invoiced' RETURNING id`;
    if (upd) credited += 1;
  }
  return credited;
}

// Orders for one company (for the CRM company credit card). Reconciles first so
// the list + balance reflect any just-paid invoices.
export async function listVideoCreditOrders(companyId) {
  await ensureVideoCreditOrders().catch(() => {});
  try {
    await reconcileVideoCreditOrders([companyId]);
    const rows = await sql`
      SELECT * FROM video_credit_orders
       WHERE company_id = ${companyId} AND status <> 'cancelled'
       ORDER BY created_at DESC LIMIT 50`;
    return rows.map(serialiseOrder);
  } catch { return []; }
}
