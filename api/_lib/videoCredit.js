// Video Credit — the client-portal "buy a block of production minutes now, draw
// it down later" feature. It deliberately reuses the existing partner-credit
// ledger (partner_subscriptions + credit_allocations, measured in MINUTES of
// finished video) so a portal purchase shows up in the CRM's Partners & Credits
// list and the company page mirror with no parallel system.
//
// Pricing mirrors the one-off "Content Credit" ladder in src/defaults.js
// (makeContentCreditTemplate): a per-minute rate discounted more the more
// minutes you buy. This is the SERVER-SIDE authority — the portal computes the
// same numbers for display, but the Stripe amount is always recomputed here.

import sql from './db.js';
import { creditTotalsForKeys } from './partnerCredits.js';
import { notifyPortalUser } from './portal/notifications.js';
import { sendNotification, ensurePortalNotificationDefaults } from './notifications.js';
import { VIDEO_CREDIT, videoCreditDiscount, videoCreditQuote } from './videoCreditPricing.js';

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

// Resolve a company's partner-credit client_keys the same three ways the CRM
// company mirror does (proposal→deal→company, shared Xero contact, name match).
// Returns [] when the company has no credit anchored yet.
export async function resolveCompanyCreditKeys(company) {
  if (!company?.id) return [];
  const rows = await sql`
    SELECT DISTINCT ps.client_key
      FROM partner_subscriptions ps
      LEFT JOIN proposals p ON p.id = ps.proposal_id
      LEFT JOIN deals d ON d.id = p.deal_id
     WHERE d.company_id = ${company.id}
        OR (${company.xero_contact_id}::text IS NOT NULL AND ps.xero_contact_id = ${company.xero_contact_id})
        OR LOWER(ps.client_name) = LOWER(${company.name})`;
  return rows.map((r) => r.client_key);
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
  const existing = await resolveCompanyCreditKeys(company);
  if (existing.length) return existing[0];
  const key = (String(company.name || '').trim().toLowerCase()) || ('company_' + company.id);
  const subId = 'manual_portalcredit_' + company.id;
  await sql`
    INSERT INTO partner_subscriptions
      (stripe_subscription_id, proposal_id, client_key, client_name,
       credits_per_month, status, auto_credit, xero_contact_id)
    VALUES
      (${subId}, NULL, ${key}, ${company.name || key},
       0, 'active', FALSE, ${company.xero_contact_id || null})
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
